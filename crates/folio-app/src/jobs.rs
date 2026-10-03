//! Session-local jobs. Workers own cancellation; the UI only observes snapshots.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::ipc::jobs::{Job, JobKind, JobResult, JobStatus, Progress};
use crate::library::lock;

const FINISHED_LIMIT: usize = 20;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) fn id() -> Result<String, AppError> {
    folio_core::meta::LibraryId::generate()
        .map(|id| id.as_str().to_owned())
        .map_err(|error| AppError::Internal(error.to_string()))
}

pub(crate) struct Registry {
    jobs: Mutex<VecDeque<Record>>,
    emit: Arc<dyn Fn(Job) + Send + Sync>,
}

struct Record {
    job: Job,
    cancel: Arc<AtomicBool>,
    last_progress: Option<Instant>,
}

#[derive(Clone)]
pub(crate) struct Ticket {
    pub id: String,
    pub cancel: Arc<AtomicBool>,
}

fn active(status: &JobStatus) -> bool {
    matches!(status, JobStatus::Queued | JobStatus::Running { .. })
}

impl Registry {
    pub fn new(emit: Arc<dyn Fn(Job) + Send + Sync>) -> Self {
        Self {
            jobs: Mutex::new(VecDeque::new()),
            emit,
        }
    }

    pub fn queue(&self, kind: JobKind, cancellable: bool) -> Result<Ticket, AppError> {
        let mut records = lock(&self.jobs);
        if kind != JobKind::Import
            && records
                .iter()
                .any(|record| record.job.kind == kind && active(&record.job.status))
        {
            return Err(AppError::Busy(format!(
                "{kind:?} is already queued or running"
            )));
        }
        let ticket = Ticket {
            id: id()?,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let job = Job {
            id: ticket.id.clone(),
            kind,
            cancellable,
            status: JobStatus::Queued,
        };
        records.push_back(Record {
            job: job.clone(),
            cancel: ticket.cancel.clone(),
            last_progress: None,
        });
        drop(records);
        (self.emit)(job);
        Ok(ticket)
    }

    pub fn list(&self) -> Vec<Job> {
        let records = lock(&self.jobs);
        records
            .iter()
            .filter(|r| active(&r.job.status))
            .chain(records.iter().filter(|r| !active(&r.job.status)))
            .map(|r| r.job.clone())
            .collect()
    }

    /// Whether a job of `kind` is queued or running.
    pub fn busy(&self, kind: JobKind) -> bool {
        lock(&self.jobs)
            .iter()
            .any(|r| r.job.kind == kind && active(&r.job.status))
    }

    /// A queued job is cancelled at once; a running one when its worker next checks the flag.
    pub fn cancel(&self, id: &str) -> Result<(), AppError> {
        let mut records = lock(&self.jobs);
        let index = records
            .iter()
            .position(|r| r.job.id == id && active(&r.job.status))
            .ok_or_else(|| AppError::NotFound("job is unknown or finished".to_owned()))?;
        if !records[index].job.cancellable {
            return Err(AppError::InvalidArgument(
                "job is not cancellable".to_owned(),
            ));
        }
        records[index].cancel.store(true, Ordering::Release);
        let retired = retire_queued(&mut records, index);
        drop(records);
        if let Some(job) = retired {
            (self.emit)(job);
        }
        Ok(())
    }

    pub fn cancel_all(&self) {
        let mut records = lock(&self.jobs);
        let mut retired = Vec::new();
        let mut index = 0;
        while index < records.len() {
            let record = &records[index];
            if active(&record.job.status) && record.job.cancellable {
                record.cancel.store(true, Ordering::Release);
                if let Some(job) = retire_queued(&mut records, index) {
                    // The record moved to the back; the next one took its place.
                    retired.push(job);
                    continue;
                }
            }
            index += 1;
        }
        drop(records);
        for job in retired {
            (self.emit)(job);
        }
    }

    /// Moves the job from queued to running; `false` if it was cancelled while queued.
    pub fn start(&self, ticket: &Ticket) -> Result<bool, AppError> {
        let mut records = lock(&self.jobs);
        let record = records
            .iter_mut()
            .find(|r| r.job.id == ticket.id)
            .filter(|r| active(&r.job.status));
        let Some(record) = record else {
            return if ticket.cancel.load(Ordering::Acquire) {
                Ok(false)
            } else {
                Err(AppError::Internal("worker lost its job".to_owned()))
            };
        };
        record.job.status = JobStatus::Running {
            progress: progress(0, None),
        };
        record.last_progress = Some(Instant::now());
        let job = record.job.clone();
        drop(records);
        (self.emit)(job);
        Ok(true)
    }

    pub fn progress(&self, ticket: &Ticket, done: u64, total: Option<u64>) -> Result<(), AppError> {
        self.report_progress(ticket, progress(done, total))
    }

    /// Import jobs also report bytes and the current source-relative name, under the same
    /// throttle and state checks as scans and hashing.
    pub fn report_progress(&self, ticket: &Ticket, progress: Progress) -> Result<(), AppError> {
        let mut records = lock(&self.jobs);
        let record = records
            .iter_mut()
            .find(|r| r.job.id == ticket.id)
            .ok_or_else(|| AppError::Internal("worker lost its job".to_owned()))?;
        if !matches!(record.job.status, JobStatus::Running { .. }) {
            return Err(AppError::Internal(
                "a job reported progress without running".to_owned(),
            ));
        }
        record.job.status = JobStatus::Running { progress };
        let now = Instant::now();
        if record
            .last_progress
            .is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL)
        {
            return Ok(());
        }
        record.last_progress = Some(now);
        let job = record.job.clone();
        drop(records);
        (self.emit)(job);
        Ok(())
    }

    /// Ends a job: `Ok(None)` when it was cancelled with nothing to report.
    pub fn finish(
        &self,
        ticket: &Ticket,
        result: Result<Option<JobResult>, AppError>,
    ) -> Result<(), AppError> {
        self.end(
            ticket,
            match result {
                Ok(Some(result)) => JobStatus::Done { result },
                Ok(None) => JobStatus::Cancelled { result: None },
                Err(error) => JobStatus::Failed { error },
            },
        )
    }

    /// Ends a cancelled job with what it did before it stopped (imports, ipc-m1 §13).
    pub fn finish_cancelled(&self, ticket: &Ticket, result: JobResult) -> Result<(), AppError> {
        self.end(
            ticket,
            JobStatus::Cancelled {
                result: Some(result),
            },
        )
    }

    fn end(&self, ticket: &Ticket, status: JobStatus) -> Result<(), AppError> {
        let mut records = lock(&self.jobs);
        let index = records
            .iter()
            .position(|r| r.job.id == ticket.id)
            .ok_or_else(|| AppError::Internal("worker lost its job".to_owned()))?;
        if !active(&records[index].job.status) {
            return Err(AppError::Internal("a job finished twice".to_owned()));
        }
        let job = retire(&mut records, index, status);
        drop(records);
        (self.emit)(job);
        Ok(())
    }
}

fn progress(done: u64, total: Option<u64>) -> Progress {
    Progress {
        done: count(done),
        total: total.map(count),
        permille: None,
        current: None,
    }
}

fn retire_queued(records: &mut VecDeque<Record>, index: usize) -> Option<Job> {
    matches!(records[index].job.status, JobStatus::Queued)
        .then(|| retire(records, index, JobStatus::Cancelled { result: None }))
}

/// Gives the job its final status and keeps only the last `FINISHED_LIMIT` finished jobs.
fn retire(records: &mut VecDeque<Record>, index: usize, status: JobStatus) -> Job {
    let mut record = records.remove(index).expect("index of an existing record");
    record.job.status = status;
    let job = record.job.clone();
    records.push_back(record);
    while records.iter().filter(|r| !active(&r.job.status)).count() > FINISHED_LIMIT {
        if let Some(index) = records.iter().position(|r| !active(&r.job.status)) {
            records.remove(index);
        }
    }
    job
}

pub(crate) fn count(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_progress_and_finished_retention_follow_contract() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let registry = Registry::new(Arc::new(move |job| capture.lock().unwrap().push(job)));
        let ticket = registry.queue(JobKind::Scan, true).unwrap();
        assert!(matches!(
            registry.queue(JobKind::Scan, true),
            Err(AppError::Busy(_))
        ));
        assert!(registry.start(&ticket).unwrap());
        for n in 1..100 {
            registry.progress(&ticket, n, None).unwrap();
        }
        assert_eq!(events.lock().unwrap().len(), 2);
        registry.cancel(&ticket.id).unwrap();
        assert!(ticket.cancel.load(Ordering::Acquire));
        registry.finish(&ticket, Ok(None)).unwrap();
        assert!(matches!(
            registry.cancel(&ticket.id),
            Err(AppError::NotFound(_))
        ));
        let fixed = registry.queue(JobKind::Import, false).unwrap();
        assert!(matches!(
            registry.cancel(&fixed.id),
            Err(AppError::InvalidArgument(_))
        ));
        for _ in 0..25 {
            let ticket = registry.queue(JobKind::Hash, true).unwrap();
            registry.start(&ticket).unwrap();
            registry
                .finish(
                    &ticket,
                    Ok(Some(JobResult::Hash {
                        hashed: 1,
                        deferred: 0,
                    })),
                )
                .unwrap();
        }
        let jobs = registry.list();
        assert_eq!(jobs.len(), 21);
        assert_eq!(jobs[0].id, fixed.id);
        assert!(
            jobs[1..]
                .iter()
                .all(|job| matches!(job.status, JobStatus::Done { .. }))
        );
    }

    #[test]
    fn imports_queue_independently_and_keep_full_throttled_progress() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let registry = Registry::new(Arc::new(move |job| lock(&capture).push(job)));
        let first = registry.queue(JobKind::Import, true).unwrap();
        let second = registry.queue(JobKind::Import, true).unwrap();
        assert_eq!(
            registry
                .list()
                .iter()
                .map(|job| job.id.as_str())
                .collect::<Vec<_>>(),
            [first.id.as_str(), second.id.as_str()]
        );
        registry.start(&first).unwrap();
        registry
            .report_progress(
                &first,
                Progress {
                    done: 2,
                    total: Some(4),
                    permille: Some(500),
                    current: Some("folder/current.txt".into()),
                },
            )
            .unwrap();
        let jobs = registry.list();
        let JobStatus::Running { progress } = &jobs[0].status else {
            panic!("{jobs:?}");
        };
        assert_eq!(
            (
                progress.done,
                progress.total,
                progress.permille,
                progress.current.as_deref()
            ),
            (2, Some(4), Some(500), Some("folder/current.txt"))
        );
        // The initial Running event and stored progress share the existing 250ms throttle.
        assert_eq!(lock(&events).len(), 3);
        registry.cancel(&second.id).unwrap();
        assert!(!registry.start(&second).unwrap());
        assert!(registry.busy(JobKind::Import));
        registry.finish(&first, Ok(None)).unwrap();
        assert!(!registry.busy(JobKind::Import));
    }

    #[test]
    fn a_job_cancelled_while_queued_finishes_at_once_and_never_runs() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let registry = Registry::new(Arc::new(move |job| capture.lock().unwrap().push(job)));
        let hash = registry.queue(JobKind::Hash, true).unwrap();
        registry.cancel(&hash.id).unwrap();
        let rebuild = registry.queue(JobKind::Rebuild, true).unwrap();
        let scan = registry.queue(JobKind::Scan, true).unwrap();
        assert!(registry.start(&scan).unwrap());
        registry.cancel_all();

        let statuses: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .map(|job| (job.id.clone(), job.status.clone()))
            .collect();
        let cancelled = JobStatus::Cancelled { result: None };
        assert!(statuses.contains(&(hash.id.clone(), cancelled.clone())));
        assert!(statuses.contains(&(rebuild.id.clone(), cancelled)));
        assert!(!registry.busy(JobKind::Hash) && !registry.busy(JobKind::Rebuild));
        assert!(!registry.start(&hash).unwrap());
        assert!(!registry.start(&rebuild).unwrap());
        assert!(
            statuses
                .iter()
                .all(|(id, status)| id == &scan.id || !matches!(status, JobStatus::Running { .. }))
        );
        // The running scan stops at its next check and finishes itself.
        assert!(scan.cancel.load(Ordering::Acquire) && registry.busy(JobKind::Scan));
        registry.finish(&scan, Ok(None)).unwrap();
        assert!(!registry.busy(JobKind::Scan));
    }

    #[test]
    fn a_cancelled_import_keeps_what_it_did_and_ends_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let registry = Registry::new(Arc::new(move |job| capture.lock().unwrap().push(job)));
        let import = registry.queue(JobKind::Import, true).unwrap();
        assert!(registry.start(&import).unwrap());
        registry.cancel(&import.id).unwrap();
        let result = JobResult::Import(crate::ipc::import::ImportResult {
            imported: 7,
            replaced: 0,
            renamed: 1,
            skipped: 0,
            originals_deleted: 0,
            failures: Vec::new(),
            failure_count: 0,
        });
        registry.finish_cancelled(&import, result.clone()).unwrap();

        let last = events.lock().unwrap().last().cloned().unwrap();
        assert_eq!(
            last.status,
            JobStatus::Cancelled {
                result: Some(result.clone())
            }
        );
        assert_eq!(registry.list()[0].status, last.status);
        assert!(registry.finish_cancelled(&import, result).is_err());
    }
}
