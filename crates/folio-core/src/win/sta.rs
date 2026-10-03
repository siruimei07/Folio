//! The scoped worker lifecycle shared by the shell's dialogs and the Recycle Bin.

use std::any::Any;
use std::io;
use std::thread::{self, Builder};

/// A worker failure, separate from whatever result the work itself returns.
#[derive(Debug, thiserror::Error)]
pub enum StaError {
    #[error("start STA worker: {0}")]
    Spawn(#[source] io::Error),
    #[error("initialize STA worker: {0}")]
    Initialize(#[source] windows::core::Error),
    #[error("STA worker panicked")]
    Panicked(Box<dyn Any + Send>),
}

/// Runs `work` on a fresh thread after `initialize` creates its STA guard. The guard is made
/// and dropped on that thread, including on error or panic; it need not be `Send`. The caller
/// chooses COM or WinRT initialization and maps worker failures without changing its policy.
/// Keep apartment-bound interfaces inside `work`. Call from a blocking worker without locks.
/// WinRT callers must hold the process MTA before using cached factories (windows-adapter §4.1).
pub fn in_sta<T: Send, A>(
    thread: Builder,
    initialize: impl FnOnce() -> windows::core::Result<A> + Send,
    work: impl FnOnce() -> T + Send,
) -> Result<T, StaError> {
    thread::scope(|scope| {
        thread
            .spawn_scoped(scope, || {
                let _apartment = initialize().map_err(StaError::Initialize)?;
                Ok(work())
            })
            .map_err(StaError::Spawn)?
            .join()
            .map_err(StaError::Panicked)?
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::ThreadId;

    use windows::Win32::Foundation::E_FAIL;

    use super::*;

    struct Guard<'a> {
        created_on: ThreadId,
        dropped: &'a AtomicBool,
        // An apartment guard must never need Send: it belongs entirely to the worker.
        _not_send: Rc<Cell<()>>,
    }

    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            assert_eq!(thread::current().id(), self.created_on);
            self.dropped.store(true, Ordering::Relaxed);
        }
    }

    fn guard(dropped: &AtomicBool) -> Guard<'_> {
        Guard {
            created_on: thread::current().id(),
            dropped,
            _not_send: Rc::new(Cell::new(())),
        }
    }

    #[test]
    fn borrowed_work_runs_on_a_named_thread_and_drops_its_local_guard_before_return() {
        let dropped = AtomicBool::new(false);
        let caller = thread::current().id();
        let value = String::from("borrowed input");
        let result = in_sta(
            Builder::new().name("folio-sta-test".into()),
            || Ok(guard(&dropped)),
            || {
                assert_ne!(thread::current().id(), caller);
                assert_eq!(thread::current().name(), Some("folio-sta-test"));
                assert!(!dropped.load(Ordering::Relaxed));
                value.len()
            },
        )
        .unwrap();
        assert_eq!(result, value.len());
        assert!(dropped.load(Ordering::Relaxed));
    }

    #[test]
    fn failed_initialization_does_not_run_work() {
        let ran = AtomicBool::new(false);
        let result = in_sta(
            Builder::new(),
            || Err::<(), _>(E_FAIL.into()),
            || ran.store(true, Ordering::Relaxed),
        );
        let Err(StaError::Initialize(error)) = result else {
            panic!("expected initialization failure, got {result:?}");
        };
        assert_eq!(error.code(), E_FAIL);
        assert!(!ran.load(Ordering::Relaxed));
    }

    #[test]
    fn a_work_error_is_returned_unchanged_after_guard_cleanup() {
        let dropped = AtomicBool::new(false);
        let result = in_sta(
            Builder::new(),
            || Ok(guard(&dropped)),
            || Err::<(), _>("work failed"),
        )
        .unwrap();
        assert_eq!(result, Err("work failed"));
        assert!(dropped.load(Ordering::Relaxed));
    }

    #[test]
    fn a_worker_panic_keeps_its_payload_and_cleans_up_before_the_next_call() {
        let dropped = AtomicBool::new(false);
        let result = in_sta(
            Builder::new(),
            || Ok(guard(&dropped)),
            || std::panic::panic_any(37_u32),
        );
        let Err(StaError::Panicked(payload)) = result else {
            panic!("expected worker panic, got {result:?}");
        };
        assert_eq!(payload.downcast_ref::<u32>(), Some(&37));
        assert!(dropped.load(Ordering::Relaxed));
        assert_eq!(in_sta(Builder::new(), || Ok(()), || 42).unwrap(), 42);
    }
}
