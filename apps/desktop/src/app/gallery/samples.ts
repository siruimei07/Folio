// Sample data for the gallery and the component tests: jobs in each state, courses, tags.

import type { Course, Job, Tag } from '../../ipc';
import type { ActivityJob } from '../activity/status';

const MINUTE = 60_000;

export function sampleJobs(now: number): ActivityJob[] {
  const jobs: { job: Job; target?: string; finishedAt?: number }[] = [
    {
      job: {
        id: 'scan-1',
        kind: 'scan',
        cancellable: true,
        status: {
          state: 'running',
          progress: { done: 4210, total: 11000, permille: null, current: 'MAT232/Problem sets/ps3-solutions.docx' },
        },
      },
    },
    { job: { id: 'hash-1', kind: 'hash', cancellable: true, status: { state: 'queued' } } },
    {
      job: {
        id: 'import-1',
        kind: 'import',
        cancellable: false,
        status: {
          state: 'done',
          result: {
            kind: 'import',
            imported: 12,
            replaced: 3,
            renamed: 1,
            skipped: 0,
            originalsDeleted: 0,
            failures: [],
            failureCount: 0,
          },
        },
      },
      target: 'MAT232',
      finishedAt: now - 18 * MINUTE,
    },
    {
      job: {
        id: 'import-2',
        kind: 'import',
        cancellable: false,
        status: {
          state: 'done',
          result: {
            kind: 'import',
            imported: 10,
            replaced: 0,
            renamed: 0,
            skipped: 0,
            originalsDeleted: 0,
            failures: [
              { name: 'lab2/data.csv', error: { code: 'InUse', detail: 'sharing violation' } },
              { name: 'lab2/notes.md', error: { code: 'InUse', detail: 'sharing violation' } },
            ],
            failureCount: 2,
          },
        },
      },
      target: 'CSC207',
      finishedAt: now - 50 * MINUTE,
    },
    {
      job: { id: 'hash-0', kind: 'hash', cancellable: false, status: { state: 'done', result: { kind: 'hash', hashed: 1240, deferred: 0 } } },
      finishedAt: now - 3 * 24 * 60 * MINUTE,
    },
  ];
  return jobs;
}

export const SAMPLE_COURSES: Course[] = [
  course('CSC207', 'Software Design', 'blue', 4),
  course('CSC236', 'Theory of Computation', 'violet', 4, 'ToC'),
  course('ECO101', 'Principles of Microeconomics', 'pink', 2),
  course('MAT232', 'Calculus of Several Variables', 'orange', 10),
  course(null, '线性代数', null, 3),
];

function course(code: string | null, name: string, color: string | null, files: number, abbr: string | null = null): Course {
  return {
    folder: { id: `course-${name}`, path: `Fall 2026/${code ?? name}` },
    name,
    abbr,
    code,
    color,
    archived: false,
    files,
  };
}

export const SAMPLE_TAGS: Tag[] = [
  { id: 't1', name: 'Notes', color: 'blue', usage: 12 },
  { id: 't2', name: 'Slides', color: 'orange', usage: 8 },
  { id: 't3', name: 'Homework', color: 'green', usage: 5 },
  { id: 't4', name: 'Exams', color: 'red', usage: 2 },
  { id: 't5', name: 'Reference', color: 'violet', usage: 1 },
];
