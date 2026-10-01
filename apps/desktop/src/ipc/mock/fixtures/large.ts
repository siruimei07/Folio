// The large library: 50,000 entries from a seeded generator (docs/specs/ui-architecture.md §2,
// §11.1), for scrolling, jumping and searching at full scale in the browser pane. Eight semesters
// of six courses, folders up to seven levels deep, and one folder of 10,000 photos. The same seed
// gives the same library, so a screen looks the same every time.
import { PALETTE } from '../../../lib/palette';
import { IMPORTANT, presetTags, SeedBuilder, seededRandom, TO_REVIEW } from './build';
import type { LibrarySeed, SeedTag } from './types';

export const LARGE_ENTRIES = 50_000;
const CAMERA_ROLL = 10_000;

const SEMESTERS = [
  'Fall 2023',
  'Winter 2024',
  'Fall 2024',
  '2025 春季学期',
  'Fall 2025',
  'Winter 2026',
  'Fall 2026',
];

const COURSES: [code: string | null, name: string][] = [
  ['MAT232', 'Calculus of Several Variables'],
  ['MAT223', '线性代数'],
  ['CSC148', 'Introduction to Computer Science'],
  ['CSC207', 'Software Design'],
  ['STA257', '概率论与数理统计'],
  ['PHY131', 'Introduction to Physics I'],
  ['ECO101', 'Principles of Microeconomics'],
  ['CHM135', 'Chemistry: Physical Principles'],
  [null, '中国近代史纲要'],
  ['ENG140', 'Literature for Our Time'],
  ['PSY100', 'Introductory Psychology'],
  ['MAT237', 'Multivariable Calculus'],
  ['CSC263', 'Data Structures and Analysis'],
  ['BIO130', 'Molecular and Cell Biology'],
  ['PHL245', 'Modern Symbolic Logic'],
  ['ECE243', 'Computer Organization'],
  [null, '大学物理（下）'],
  ['STA302', 'Methods of Data Analysis'],
  ['CSC369', 'Operating Systems'],
  [null, '思想道德与法治'],
  ['MAT344', 'Introduction to Combinatorics'],
  ['CSC343', 'Introduction to Databases'],
];

const TOPICS = [
  'Vectors',
  'Limits',
  'Gradients',
  'Recursion',
  'Linked lists',
  '特征值',
  '矩阵分解',
  'Entropy',
  'Supply and demand',
  '热力学第一定律',
  'Hash tables',
  'Sorting',
  'Graphs',
  'Probability',
  '贝叶斯公式',
  'Regression',
  'Scheduling',
  'Virtual memory',
];

const WORDS = [
  'theorem',
  'proof',
  'example',
  'definition',
  'lemma',
  'exercise',
  'midterm',
  'review',
  '定理',
  '证明',
  '例题',
  '复习',
  '考点',
  'gradient',
  'matrix',
  'function',
  'algorithm',
  'complexity',
];

const MB = 1024 * 1024;

export const LARGE_TAGS: SeedTag[] = [
  ...presetTags(),
  IMPORTANT,
  TO_REVIEW,
  { id: '5b0e7c3a9d1f2468', name: 'Group project', color: 'teal' },
];

export function largeLibrary(now: number, seed = 20260930): LibrarySeed {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const between = (low: number, high: number) => low + random() * (high - low);
  const b = new SeedBuilder(now);
  // Courses stop short of this; scanned documents fill the gap to exactly LARGE_ENTRIES.
  const budget = LARGE_ENTRIES - CAMERA_ROLL - 500;

  const folder = (path: string, options: Parameters<SeedBuilder['folder']>[1] = {}) => {
    b.folder(path, options);
  };
  const file = (path: string, size: number, added: number, text?: string) => {
    const roll = random();
    const tags =
      roll < 0.12 ? ['notes'] : roll < 0.18 ? ['reference'] : roll < 0.21 ? [IMPORTANT.id, 'exam'] : [];
    b.file(path, {
      size,
      added,
      modified: random() < 0.01 ? null : Math.max(0, added - between(0, 20)),
      tags,
      ...(text === undefined ? {} : { text }),
    });
  };
  const sentence = () =>
    Array.from({ length: 24 }, () => pick(WORDS)).join(' ') + ` ${pick(TOPICS)}.`;

  SEMESTERS.forEach((semester, index) => {
    const age = (SEMESTERS.length - index) * 120; // days since the semester began
    folder(semester, { group: { order: index + 1, archived: index < 3 }, added: age });
    for (let slot = 0; slot < 6; slot++) {
      const [code, name] = COURSES[(index * 6 + slot) % COURSES.length] ?? [null, 'Course'];
      const course = `${semester}/${code === null ? name : `${code} ${name}`}`;
      folder(course, {
        group: {
          order: slot + 1,
          code,
          color: PALETTE[(index + slot) % PALETTE.length] ?? null,
          archived: index < 3,
        },
        added: age,
      });
      const courses = SEMESTERS.length * 6;
      const stop = Math.floor((budget * (index * 6 + slot + 1)) / courses);
      for (let week = 1; b.size < stop; week++) {
        const added = Math.max(0, age - week * 2);
        folder(`${course}/Lectures`, { tags: ['slides'], added: age });
        file(`${course}/Lectures/Lecture ${String(week).padStart(2, '0')} - ${pick(TOPICS)}.pdf`, between(0.3, 30) * MB, added);
        if (week % 3 === 0) file(`${course}/Lectures/第${String(week)}讲 录像.mp4`, between(80, 3000) * MB, added);
        folder(`${course}/Problem sets`, { tags: ['homework'], added: age });
        file(`${course}/Problem sets/hw${String(week)}.py`, between(1, 12) * 1024, added);
        file(`${course}/Problem sets/PS${String(week)} solutions.md`, between(2, 20) * 1024, added, sentence());
        file(`${course}/Notes/week ${String(week)} notes.md`, between(1, 30) * 1024, added, sentence());
        file(`${course}/Notes/第${String(week)}章 笔记.md`, between(1, 30) * 1024, added, sentence());
        const lab = `${course}/Labs/Lab ${String(week)}`;
        file(`${lab}/lab${String(week)}.py`, between(1, 9) * 1024, added);
        file(`${lab}/report.docx`, between(30, 2000) * 1024, added);
        file(`${lab}/data/measurements.csv`, between(0.1, 400) * 1024, added);
        if (week % 4 === 0) {
          const project = `${course}/Projects/project ${String(week / 4)}/src/app/core/model`;
          file(`${project}/state.py`, between(1, 40) * 1024, added);
          file(`${project}/test_state.py`, between(1, 20) * 1024, added);
        }
        if (week % 5 === 0) {
          folder(`${course}/Exams`, { tags: ['exam'], added: age });
          file(`${course}/Exams/Midterm ${String(2020 + (week % 6))}.pdf`, between(0.2, 3) * MB, added);
        }
        if (week % 6 === 0) file(`${course}/Readings/${pick(TOPICS)} (${String(1990 + week)}).pdf`, between(0.5, 60) * MB, added);
      }
    }
  });

  // One folder of 10,000 photos: a single folder at full scale. Then scanned documents fill the
  // library up to exactly LARGE_ENTRIES.
  folder('Personal', { group: { order: SEMESTERS.length + 1 }, added: 1000 });
  for (let n = 1; n <= CAMERA_ROLL; n++) {
    b.file(`Personal/Photos/Camera Roll/IMG_${String(n).padStart(5, '0')}.HEIC`, {
      size: between(1, 4) * MB,
      added: between(0, 1000),
    });
  }
  for (let n = 1; b.size < LARGE_ENTRIES; n++) {
    file(`Personal/Documents/Scan ${String(n)}.pdf`, between(0.1, 5) * MB, between(0, 900));
  }

  return {
    name: 'Everything since first year',
    root: 'D:\\School',
    readOnly: false,
    recovered: false,
    tags: LARGE_TAGS,
    entries: b.build(),
    problems: [
      { kind: 'notNfc', folder: 'Personal/Photos/Camera Roll', name: 'Café.jpg', twin: false },
      { kind: 'unreadable', path: 'Personal/Documents/Scan 1.pdf', failure: 'denied' },
      { kind: 'invalidIgnoreRule', file: null, line: 3 },
    ],
  };
}
