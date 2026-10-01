// The small library: hand-written, about a hundred entries a student might have after two
// semesters. It covers what screens and tests need to see: Chinese and English names, course codes
// and badges, nested folders with folder tags, natural name order (hw2 before hw10), sizes from
// bytes to gigabytes, files added this week, files without tags, a file without a modification
// time, files another program holds, an archived semester, a file at the top level, and problems.
import type { ImportScript, LibrarySeed, SeedTag } from './types';
import { IMPORTANT as IMPORTANT_TAG, presetTags, SeedBuilder, TO_REVIEW as TO_REVIEW_TAG } from './build';

export const SMALL_ROOT = 'E:\\University of Toronto';

/** Tag ids of the small library: the presets plus two of the student's own. */
export const SMALL_TAGS: SeedTag[] = [...presetTags(), IMPORTANT_TAG, TO_REVIEW_TAG];

const IMPORTANT = IMPORTANT_TAG.id;
const TO_REVIEW = TO_REVIEW_TAG.id;

const MB = 1024 * 1024;

export function smallLibrary(now: number): LibrarySeed {
  const b = new SeedBuilder(now);

  b.folder('Fall 2025', { group: { order: 1, archived: true }, added: 400 });
  b.folder('Winter 2026', { group: { order: 2 }, added: 280 });
  b.folder('Fall 2026', { group: { order: 3 }, added: 40 });
  b.folder('Personal', { group: { order: 4 }, added: 400 });
  b.file('README.txt', { size: 812, added: 400, text: 'How I keep my course files. 课程文件整理说明。' });

  // Fall 2026
  const mat = 'Fall 2026/MAT232 Calculus of Several Variables';
  b.folder(mat, { group: { order: 1, code: 'MAT232', abbr: 'MAT', color: 'blue' }, added: 40 });
  b.folder(`${mat}/Lectures`, { tags: ['slides'], added: 40 });
  for (let n = 1; n <= 12; n++) {
    const number = String(n).padStart(2, '0');
    b.file(`${mat}/Lectures/Lecture ${number}.pdf`, { size: 1.2 * MB + n * 91_337, added: 40 - n * 3 });
  }
  b.folder(`${mat}/Problem sets`, { tags: ['homework'], added: 38 });
  for (let n = 1; n <= 10; n++) {
    b.file(`${mat}/Problem sets/PS${String(n)}.pdf`, { size: 180_000 + n * 4_096, added: 38 - n * 3 });
  }
  b.file(`${mat}/Problem sets/ps2 solutions.md`, {
    size: 6_214,
    added: 30,
    tags: [TO_REVIEW],
    text: 'Problem 3: the gradient of f(x, y) = x²y is (2xy, x²). 偏导数先对 x 求，再对 y 求。',
  });
  b.folder(`${mat}/Exams/Midterm`, { tags: ['exam'], added: 12 });
  b.file(`${mat}/Exams/Midterm/Midterm 2025.pdf`, { size: 420_112, added: 12, tags: [IMPORTANT] });
  b.file(`${mat}/Exams/Midterm/Midterm review.md`, {
    size: 9_870,
    added: 2,
    tags: ['notes'],
    text: 'Review: chain rule, directional derivatives, Lagrange multipliers. 拉格朗日乘数法要背公式。',
  });
  b.file(`${mat}/第3章 偏导数.md`, {
    size: 12_402,
    added: 20,
    tags: ['notes'],
    text: '偏导数的定义：固定其他变量，对一个变量求导。Partial derivatives and the tangent plane.',
  });
  b.file(`${mat}/week 2 notes.md`, {
    size: 4_311,
    added: 33,
    tags: ['notes'],
    text: 'Week 2: vectors, dot product, cross product and the equation of a plane.',
  });

  const linear = 'Fall 2026/线性代数';
  b.folder(linear, { group: { order: 2, code: 'MAT223', abbr: '线代', color: 'violet' }, added: 40 });
  b.file(`${linear}/第一章 行列式.pdf`, { size: 3.4 * MB, added: 39, tags: ['slides'] });
  b.file(`${linear}/第二章 矩阵.pdf`, { size: 4.1 * MB, added: 25, tags: ['slides'] });
  b.file(`${linear}/笔记.md`, {
    size: 18_220,
    added: 1,
    tags: ['notes', IMPORTANT],
    text: '矩阵的秩等于其行阶梯形中非零行的个数。Rank–nullity theorem: rank + nullity = n.',
  });
  b.folder(`${linear}/习题`, { tags: ['homework'], added: 30 });
  for (let n = 1; n <= 4; n++) b.file(`${linear}/习题/习题 ${String(n)}.docx`, { size: 38_000 + n * 1_111, added: 30 - n * 5 });

  const csc = 'Fall 2026/CSC148 Introduction to Computer Science';
  b.folder(csc, { group: { order: 3, code: 'CSC148', color: 'green' }, added: 40 });
  for (const n of [1, 2, 3, 10, 11, 12]) {
    b.file(`${csc}/hw${String(n)}.py`, { size: 1_200 + n * 97, added: 40 - n * 2, tags: ['homework'] });
  }
  b.file(`${csc}/README.md`, { size: 2_048, added: 40, text: 'Assignment setup: python -m pytest. 运行测试前先装依赖。' });
  b.folder(`${csc}/labs/lab1`, { added: 35 });
  b.file(`${csc}/labs/lab1/lab1.py`, { size: 3_320, added: 35 });
  b.file(`${csc}/labs/lab1/report.docx`, { size: 64_000, added: 34 });
  b.file(`${csc}/labs/lab2/lab2.py`, { size: 4_870, added: 28 });
  b.file(`${csc}/labs/lab2/data.csv`, { size: 128, added: 28 });
  b.file(`${csc}/a1/starter/tree.py`, { size: 9_990, added: 3, tags: [TO_REVIEW] });
  b.file(`${csc}/a1/starter/test_tree.py`, { size: 5_125, added: 3 });
  b.file(`${csc}/a1/run.bat`, { size: 64, added: 3 });

  const eco = 'Fall 2026/ECO101 微观经济学';
  b.folder(eco, { added: 40 });
  b.file(`${eco}/Textbook - Mankiw.pdf`, { size: 35 * MB, added: 40, tags: ['reference'] });
  b.file(`${eco}/Lecture recording week 5.mp4`, {
    size: 2.3 * 1024 * MB,
    added: 6,
    blocked: 'InUse',
  });
  b.file(`${eco}/Problem set 1.docx`, { size: 88_000, added: 9 });
  b.file(`${eco}/Supply and demand.png`, { size: 412_000, added: 9 });

  // Winter 2026
  const phy = 'Winter 2026/PHY131 Introduction to Physics I';
  b.folder(phy, { group: { order: 1, code: 'PHY131', color: 'teal' }, added: 280 });
  b.file(`${phy}/Lab 1 report.docx`, { size: 92_000, added: 270, tags: ['homework'] });
  b.file(`${phy}/Formula sheet.pdf`, { size: 210_000, added: 200, tags: ['exam', IMPORTANT] });
  b.file(`${phy}/Kinematics.md`, { size: 5_000, added: 260, text: 'v = u + at; s = ut + ½at². 匀加速直线运动。' });
  const history = 'Winter 2026/中国近代史纲要';
  b.folder(history, { group: { order: 2, abbr: '史', color: 'red' }, added: 280 });
  b.file(`${history}/期末复习提纲.docx`, { size: 56_000, added: 190, tags: ['exam'] });
  b.file(`${history}/课堂笔记.md`, { size: 21_000, added: 250, tags: ['notes'], text: '鸦片战争（1840）是中国近代史的开端。' });

  // Fall 2025 (archived)
  const intro = 'Fall 2025/CSC108 Introduction to Programming';
  b.folder(intro, { group: { order: 1, code: 'CSC108', color: 'indigo', archived: true }, added: 400 });
  b.file(`${intro}/Final exam.pdf`, { size: 300_000, added: 330, tags: ['exam'] });
  b.file(`${intro}/a3.py`, { size: 7_000, added: 350, tags: ['homework'] });

  // Personal
  b.file('Personal/Photos/IMG_2031.HEIC', { size: 2.8 * MB, added: 1 });
  b.file('Personal/Photos/Screenshot 2026-09-12.png', { size: 640_000, added: 18 });
  b.file('Personal/Photos/scan.jpg', { size: 1.1 * MB, added: 70 });
  b.file('Personal/Old backup.zip', { size: 734 * MB, modified: null, added: 380 });
  b.file('Personal/Todo.txt', { size: 96, added: 5, text: 'Todo: email TA about the midterm regrade.' });
  b.file('Personal/todo.txt', { size: 44, added: 5, text: 'buy groceries' });
  b.file('Personal/Archive/2024/Scans/Receipts/Everything I scanned in first year, kept just in case.pdf', {
    size: 12 * MB,
    added: 390,
    blocked: 'NotRecyclable',
  });
  b.file('Personal/empty.txt', { size: 0, added: 60 });

  return {
    name: 'University of Toronto',
    root: SMALL_ROOT,
    readOnly: false,
    recovered: false,
    tags: SMALL_TAGS,
    entries: b.build(),
    problems: [
      { kind: 'notNfc', folder: 'Fall 2026/线性代数', name: 'Cafe\u0301.md', twin: false },
      { kind: 'caseTwins', paths: ['Personal/Todo.txt', 'Personal/todo.txt'] },
      { kind: 'link', folder: 'Personal', name: 'Shortcut to Drive' },
      {
        kind: 'unreadable',
        path: 'Fall 2026/ECO101 微观经济学/Lecture recording week 5.mp4',
        failure: 'inUse',
      },
      { kind: 'invalidName', folder: 'Personal', name: 'aux.txt', rule: 'reservedName' },
      { kind: 'orphanedMetadata', folder: 'Fall 2024' },
    ],
  };
}

/** What "Add files" picks, or a drop brings, unless a test scripts something else. */
export function sampleImport(): ImportScript {
  return {
    names: [
      { name: 'Lecture 05 - Gradients.pdf', kind: 'file' },
      { name: 'hw3.py', kind: 'file' },
      { name: 'Lab 2', kind: 'folder' },
    ],
    items: [
      { path: 'Lecture 05 - Gradients.pdf', kind: 'file', size: String(3 * MB) },
      { path: 'hw3.py', kind: 'file', size: '2310' },
      { path: 'Lab 2', kind: 'folder', size: '0' },
      { path: 'Lab 2/report.docx', kind: 'file', size: '71000' },
      { path: 'Lab 2/data.csv', kind: 'file', size: '4410' },
      { path: 'Lab 2/node_modules', kind: 'folder', size: '0' },
      { path: 'Lab 2/node_modules/left-pad.js', kind: 'file', size: '512' },
    ],
  };
}
