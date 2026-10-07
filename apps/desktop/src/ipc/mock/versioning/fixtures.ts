// Histories and workspaces for the fake shell's M2 scenarios (docs/specs/ipc-m2.md §17). They are
// built on the small library: changes name its files, so open, reveal and "View history" find
// them. Times are days before `now`, like the library fixtures.
import type { HistoryState, MetadataSubject, TagChange } from '../../bindings';
import { IMPORTANT, presetTags, seededRandom, TO_REVIEW } from '../fixtures/build';
import type { SeedTag } from '../fixtures/types';
import type { FakeLibrary } from '../library';
import { randomHex } from '../random';
import type { AiSeed } from './ai';
import {
  blobVersion,
  change,
  commitId,
  type FakeChange,
  type FakeCommit,
  type FakeItem,
  type FakeMeta,
  type FakeOp,
  hashOf,
  firstChanges,
  item,
  noHistory,
  textVersion,
  type Version,
  type VersioningSeed,
  wordVersion,
} from './model';
import { largeWorkspace } from './workspaceLarge';

/** What a scenario gives the fake shell for M2: the library's history, and AI on this computer. */
export interface VersioningFixture {
  history: (library: FakeLibrary, now: number) => VersioningSeed;
  ai: AiSeed;
}

const DAY = 86_400_000;
const MB = 1024 * 1024;
const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const LINEAR = 'Fall 2026/线性代数';
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const ECO = 'Fall 2026/ECO101 微观经济学';
const PHY = 'Winter 2026/PHY131 Introduction to Physics I';
const CHINESE_HISTORY = 'Winter 2026/中国近代史纲要';

const G16 = { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' };
const IPAD = { id: '5d2a7c9e1b3f48a6c0e4d8b2f6a1c3e5', name: 'iCloud' };

/** The midterm review: the small library's most edited file. */
export const MIDTERM_REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
const REVIEW = MIDTERM_REVIEW;
const WEEK2 = `${MAT}/week 2 notes.md`;
const CHAPTER3 = `${MAT}/第3章 偏导数.md`;
const LINEAR_NOTES = `${LINEAR}/笔记.md`;
/** Exercise 1 as committed: in "Exercises", which the small workspace renames to 习题. */
const EXERCISE1_COMMITTED = `${LINEAR}/Exercises/习题 1.docx`;

/** The midterm review as it was saved over the term: each version adds to the last. */
const REVIEW_TEXT = [
  ['# Midterm review', '', '## Chain rule', 'Write z = f(x(t), y(t)).', 'dz/dt = f_x x′ + f_y y′.'],
  [
    '# Midterm review',
    '',
    '## Chain rule',
    'Write z = f(x(t), y(t)).',
    'dz/dt = f_x x′(t) + f_y y′(t).',
    '',
    '## Directional derivatives',
    'D_u f = ∇f · u along a unit vector u.',
  ],
  [
    '# Midterm review',
    '',
    '## Chain rule',
    'Write z = f(x(t), y(t)).',
    'dz/dt = f_x x′(t) + f_y y′(t).',
    '',
    '## Directional derivatives',
    'D_u f = ∇f · u along a unit vector u.',
    'The gradient points the way f grows fastest.',
    '',
    '## Lagrange multipliers',
    '∇f = λ∇g on the constraint g = c.',
    '拉格朗日乘数法要背公式。',
  ],
  [
    '# Midterm review',
    '',
    '## Chain rule',
    'Write z = f(x(t), y(t)) and differentiate through both paths.',
    'dz/dt = f_x x′(t) + f_y y′(t).',
    '',
    '## Directional derivatives',
    'D_u f = ∇f · u along a unit vector u.',
    'The gradient points the way f grows fastest.',
    '',
    '## Lagrange multipliers',
    '∇f = λ∇g on the constraint g = c.',
    'Check the boundary too.',
    '拉格朗日乘数法要背公式，边界也要检查。',
  ],
].map((lines) => lines.join('\n'));

const WEEK2_TEXT = [
  'Week 2: vectors, dot product, cross product.\nu · v = |u||v| cos θ.',
  'Week 2: vectors, dot product, cross product and the equation of a plane.\nu · v = |u||v| cos θ.\nA plane: n · (r − r₀) = 0.',
];

const EXERCISE_TEXT = [
  ['习题 1', '1. 计算行列式。', '2. 证明 det(AB) = det(A) det(B)。'],
  ['习题 1', '1. 计算三阶行列式。', '2. 证明 det(AB) = det(A) det(B)。', '3. 求逆矩阵。'],
];

const REPORT_TEXT = [
  ['Lab 1 report', 'Method: we timed insert and lookup.', 'Results: the tree was faster.', 'Conclusion: use the tree.'],
  [
    'Lab 1 report',
    'Method: we timed insert, lookup and delete on 10,000 keys.',
    'Results: the tree was faster for lookups.',
    'Table 1: timings in milliseconds.',
    'Conclusion: use the tree.',
  ],
];

/** The `index`th of a fixture's own list, which is there by construction. */
function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`fixture: no item ${String(index)}`);
  return value;
}

/** A value a fixture put in a map, which is there by construction. */
function got<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error('fixture: a missing value');
  return value;
}

function time(now: number, daysAgo: number): number {
  return Math.floor((now - daysAgo * DAY) / 1000) * 1000;
}

function commit(now: number, daysAgo: number, fields: Partial<FakeCommit> & Pick<FakeCommit, 'changes'>): FakeCommit {
  return {
    id: commitId(),
    kind: 'commit',
    timeMs: time(now, daysAgo),
    summary: null,
    body: null,
    device: G16,
    metadata: [],
    pruned: 0,
    ...fields,
  };
}

/** The first commit: what `start_history` would commit (ipc-m2 §7.1), but `later`, with the versions given. */
function firstCommit(library: FakeLibrary, now: number, daysAgo: number, versions: Map<string, Version>, later: Set<string>): FakeCommit {
  const changes = firstChanges(library, versions).added.filter((entry) => !later.has(entry.path));
  return commit(now, daysAgo, { summary: 'Start history', changes });
}

function modified(path: string, before: Version, after: Version): FakeChange {
  return change({ change: 'modified', kind: 'file', path, before, after });
}

/** A preset tag of the small library, by id. */
function preset(id: string): SeedTag {
  return nth(presetTags().filter((tag) => tag.id === id), 0);
}

/** Tags added to an entry, and the tags it has now, as labels. */
function tagChange(added: SeedTag[], now: SeedTag[]): TagChange {
  const label = (tag: SeedTag) => ({ id: tag.id, name: tag.name, color: tag.color });
  return { added: added.map(label), removed: [], now: now.map(label) };
}

/** A tag change of an entry without an item, read as data. */
function tagsMeta(subject: MetadataSubject & { kind: 'tags' }, added: SeedTag[], now: SeedTag[]): FakeMeta {
  return {
    key: `meta:tags:${subject.path}`,
    change: 'modified',
    subject,
    detail: { kind: 'tags', ...tagChange(added, now) },
    text: null,
  };
}

// ---- the small library's history

function smallHistory(library: FakeLibrary, now: number, state: HistoryState): VersioningSeed {
  const review = REVIEW_TEXT.map((text) => textVersion(text));
  const week2 = WEEK2_TEXT.map((text) => textVersion(text));
  const exercise = EXERCISE_TEXT.map((paragraphs, index) => wordVersion(paragraphs, 38_000 + index * 2_100));
  const linearNotes = [textVersion('矩阵的秩等于其行阶梯形中非零行的个数。'), textVersion('矩阵的秩等于其行阶梯形中非零行的个数。\nRank–nullity theorem: rank + nullity = n.')];
  const report = REPORT_TEXT.map((paragraphs, index) => wordVersion(paragraphs, 60_000 + index * 4_000));
  const versions = new Map<string, Version>([
    [REVIEW, nth(review, 0)],
    [WEEK2, nth(week2, 0)],
    [LINEAR_NOTES, nth(linearNotes, 0)],
    [`${CSC}/labs/lab1/report.docx`, nth(report, 0)],
  ]);
  const ps2 = textVersion('Problem 3: the gradient of f(x, y) = x²y is (2xy, x²).');
  const later = new Set([
    CHAPTER3,
    `${MAT}/Lectures/Lecture 12.pdf`,
    `${CSC}/a1`,
    `${CSC}/a1/starter`,
    `${CSC}/a1/starter/tree.py`,
    `${CSC}/a1/starter/test_tree.py`,
    `${CSC}/a1/run.bat`,
    'Personal/Photos/IMG_2031.HEIC',
    `${MAT}/Problem sets/ps2 solutions.md`,
    `${LINEAR}/习题`,
    `${LINEAR}/习题/习题 1.docx`,
    `${LINEAR}/习题/习题 2.docx`,
    `${LINEAR}/习题/习题 3.docx`,
    `${LINEAR}/习题/习题 4.docx`,
  ]);
  const first = firstCommit(library, now, 40, versions, later);
  // The exercises lived in "Exercises" until the workspace's folder move.
  for (let n = 1; n <= 4; n++) {
    const path = `${LINEAR}/Exercises/习题 ${String(n)}.docx`;
    first.changes.push(change({ change: 'added', kind: 'file', path, after: n === 1 ? nth(exercise, 0) : wordVersion([`习题 ${String(n)}`], 38_000 + n * 1_111) }));
  }
  first.changes.push(change({ change: 'added', kind: 'folder', path: `${LINEAR}/Exercises` }));
  first.changes.push(change({ change: 'added', kind: 'file', path: `${MAT}/ps2 solutions.md`, after: ps2 }));
  first.changes.push(change({ change: 'added', kind: 'file', path: `${MAT}/Old slides L2.pdf`, after: blobVersion(2.4 * MB, 'old slides') }));
  first.changes.push(change({ change: 'added', kind: 'file', path: `${PHY}/notes/Kinematics.md`, after: textVersion('v = u + at; s = ut + ½at².') }));

  const commits: FakeCommit[] = [
    first,
    commit(now, 33, {
      summary: 'MAT232: update 1 file',
      changes: [modified(WEEK2, nth(week2, 0), nth(week2, 1))],
    }),
    commit(now, 20, {
      summary: 'MAT232: add 1 file',
      changes: [change({ change: 'added', kind: 'file', path: CHAPTER3, after: textVersion('偏导数的定义：固定其他变量，对一个变量求导。') })],
    }),
    commit(now, 10, {
      summary: 'MAT223: update exercise 1; MAT232: update the midterm review',
      body: 'Exercise 1 gets a third question.\nThe review covers directional derivatives now.',
      changes: [modified(EXERCISE1_COMMITTED, nth(exercise, 0), nth(exercise, 1)), modified(REVIEW, nth(review, 0), nth(review, 1))],
    }),
    commit(now, 5, {
      summary: 'MAT232: add lecture 12; MAT223: update notes',
      changes: [
        change({ change: 'added', kind: 'file', path: `${MAT}/Lectures/Lecture 12.pdf`, after: blobVersion(1.2 * MB + 12 * 91_337, 'lecture 12') }),
        modified(LINEAR_NOTES, nth(linearNotes, 0), nth(linearNotes, 1)),
      ],
    }),
    commit(now, 2, {
      summary: 'MAT232: rewrite the midterm review',
      changes: [modified(REVIEW, nth(review, 1), nth(review, 2))],
    }),
  ];
  const undone = commit(now, 1.5, {
    summary: 'ECO101: add demand data',
    changes: [change({ change: 'added', kind: 'file', path: `${ECO}/demand.csv`, after: textVersion('price,quantity\n1,100') })],
  });
  const ops: FakeOp[] = [
    { kind: 'uncommit', id: randomHex(8), timeMs: time(now, 1.4), commit: undone },
    { kind: 'reword', id: randomHex(8), timeMs: time(now, 1), commit: nth(commits, 3), previous: commitId() },
  ];

  const items: FakeItem[] = [
    item({
      change: 'modified',
      kind: 'file',
      path: REVIEW,
      before: review[2] ?? null,
      after: review[3] ?? null,
      tags: tagChange([preset('exam')], [preset('notes'), preset('exam')]),
    }),
    item({ change: 'modified', kind: 'file', path: `${CSC}/labs/lab1/report.docx`, before: report[0] ?? null, after: report[1] ?? null }),
    item({ change: 'modified', kind: 'file', path: `${ECO}/Supply and demand.png`, before: blobVersion(184_000, 'supply'), after: blobVersion(412_000, 'supply') }),
    item({ change: 'added', kind: 'file', path: `${CSC}/a1/starter/tree.py`, after: textVersion('class Tree:\n    def __init__(self) -> None:\n        self.root = None') }),
    item({ change: 'added', kind: 'file', path: `${CSC}/a1/starter/test_tree.py`, after: textVersion('def test_empty() -> None:\n    assert Tree().root is None') }),
    item({ change: 'added', kind: 'file', path: `${CSC}/a1/run.bat`, after: textVersion('python -m pytest'), readiness: 'hashing' }),
    item({ change: 'deleted', kind: 'file', path: `${MAT}/Old slides L2.pdf`, before: blobVersion(2.4 * MB, 'old slides') }),
    item({
      change: 'moved',
      kind: 'file',
      path: `${MAT}/Problem sets/ps2 solutions.md`,
      fromPath: `${MAT}/ps2 solutions.md`,
      before: ps2,
      after: ps2,
    }),
    item({ change: 'moved', kind: 'folder', path: `${LINEAR}/习题`, fromPath: `${LINEAR}/Exercises`, files: 4 }),
    item({
      change: 'moved',
      kind: 'file',
      path: `${PHY}/Kinematics.md`,
      fromPath: `${PHY}/notes/Kinematics.md`,
      before: textVersion('v = u + at; s = ut + ½at².'),
      after: textVersion('v = u + at; s = ut + ½at². 匀加速直线运动。'),
      parts: [{ kind: 'entry', change: 'deleted', entryKind: 'file', path: `${PHY}/Kinematics.md`, fromPath: null }],
    }),
    item({ change: 'added', kind: 'file', path: 'Personal/Photos/IMG_2031.HEIC', after: blobVersion(2.8 * MB, 'img'), readiness: 'notLocal' }),
    item({ change: 'added', kind: 'file', path: `${ECO}/Lecture recording week 5.mp4`, after: blobVersion(2.3 * 1024 * MB, 'recording'), readiness: 'unreadable' }),
  ];
  const midterm = `${MAT}/Exams/Midterm/Midterm 2025.pdf`;
  const metadata: FakeMeta[] = [
    tagsMeta(
      { kind: 'tags', path: midterm, entryKind: 'file', entry: library.refAt(midterm) },
      [TO_REVIEW],
      [IMPORTANT, TO_REVIEW],
    ),
    {
      key: `meta:course:${CSC}`,
      change: 'modified',
      subject: { kind: 'course', path: CSC, folder: library.refAt(CSC) },
      detail: { kind: 'settings', changes: [{ field: 'color', before: 'teal', after: 'green' }, { field: 'code', before: 'CSC 148', after: 'CSC148' }] },
      text: null,
    },
    {
      key: 'meta:tagDefinitions',
      change: 'added',
      subject: { kind: 'tagDefinitions' },
      detail: { kind: 'tagDefinitions', changes: [{ id: TO_REVIEW.id, before: null, after: { name: TO_REVIEW.name, color: TO_REVIEW.color, order: 7 } }] },
      text: null,
    },
    {
      key: 'meta:ignoreRules',
      change: 'modified',
      subject: { kind: 'ignoreRules' },
      detail: null,
      text: { before: ['# My rules', '*.log'], after: ['# My rules', '*.log', '*.tmp', 'build/'] },
    },
  ];
  return { state, commits, ops, items, metadata };
}


// ---- a long history

const LONG_COMMITS = 1_200;

/** 1,200 commits over two years, with imports, a prune commit and pruned Word versions, rewords, uncommits and restores. */
function longHistory(library: FakeLibrary, now: number): VersioningSeed {
  const random = seededRandom(1_200);
  const base = smallHistory(library, now, 'ready');
  const first = { ...nth(base.commits, 0), timeMs: time(now, 730) };
  const commits: FakeCommit[] = [first];
  const texts = new Map<string, string[]>([
    [REVIEW, (REVIEW_TEXT[0] ?? '').split('\n')],
    [WEEK2, (WEEK2_TEXT[0] ?? '').split('\n')],
    [LINEAR_NOTES, ['矩阵的秩等于其行阶梯形中非零行的个数。']],
  ]);
  const current = new Map<string, Version>();
  for (const [path, lines] of texts) current.set(path, textVersion(lines.join('\n')));
  let word = wordVersion(EXERCISE_TEXT[0] ?? [], 38_000);
  const wordVersions: Version[] = [];
  const paths = [...texts.keys()];
  for (let index = 1; index < LONG_COMMITS; index++) {
    // A clock that ran 3 hours behind, once: the effective time keeps the order.
    const daysAgo = 730 - (index * 729) / LONG_COMMITS + (index === 400 ? 0.125 : 0);
    if (index === 600) {
      const pruned = wordVersions.filter((_, n) => n % 2 === 0 && n < wordVersions.length - 2);
      for (const version of pruned) version.pruned = true;
      commits.push(commit(now, daysAgo, { kind: 'prune', changes: [], pruned: pruned.length }));
      continue;
    }
    if (index % 50 === 0) {
      const path = `${MAT}/iPad notes ${String(index / 50)}.md`;
      commits.push(
        commit(now, daysAgo, {
          kind: 'import',
          device: IPAD,
          summary: 'Changes from iCloud',
          changes: [change({ change: 'added', kind: 'file', path, after: textVersion(`Notes written on the iPad, part ${String(index / 50)}.`) })],
        }),
      );
      continue;
    }
    if (index % 20 === 0) {
      const next = wordVersion([...(word.lines ?? []), `${String(index)}. 新的题目。`], word.size + 512);
      wordVersions.push(word);
      commits.push(commit(now, daysAgo, { summary: 'MAT223: update exercise 1', changes: [modified(EXERCISE1_COMMITTED, word, next)] }));
      word = next;
      continue;
    }
    const path = paths[Math.floor(random() * paths.length)] ?? REVIEW;
    const lines = [...(texts.get(path) ?? [])];
    const at = Math.floor(random() * (lines.length + 1));
    lines.splice(at, random() < 0.3 && lines.length > 3 ? 1 : 0, `Note ${String(index)}: ${random().toString(36).slice(2, 10)}`);
    texts.set(path, lines);
    const before = got(current, path);
    const after = textVersion(lines.join('\n'));
    current.set(path, after);
    const course = path.startsWith(LINEAR) ? 'MAT223' : 'MAT232';
    commits.push(
      commit(now, daysAgo, {
        summary: `${course}: update ${path.split('/').at(-1) ?? 'notes'}`,
        body: index % 7 === 0 ? 'Rewrote the examples.\nAdded the proofs from the tutorial.' : null,
        changes: [modified(path, before, after)],
      }),
    );
  }
  const ops: FakeOp[] = [];
  for (let n = 1; n <= 12; n++) {
    const target = nth(commits, n * 97);
    ops.push({ kind: 'reword', id: randomHex(8), timeMs: target.timeMs + 3_600_000, commit: target, previous: commitId() });
  }
  for (let n = 1; n <= 3; n++) {
    const undone = commit(now, 600 - n * 150, { summary: `ECO101: add draft ${String(n)}`, changes: [] });
    ops.push({ kind: 'uncommit', id: randomHex(8), timeMs: undone.timeMs + 60_000, commit: undone });
  }
  for (let n = 1; n <= 3; n++) {
    const source = commits.find((candidate, index) => index > n * 200 && candidate.changes[0]?.path === REVIEW);
    if (source === undefined) continue;
    ops.push({ kind: 'restore', id: randomHex(8), timeMs: source.timeMs + 86_400_000, commit: source, path: REVIEW, target: REVIEW, recycled: n === 2 });
  }
  ops.sort((a, b) => a.timeMs - b.timeMs);
  const latestReview = got(current, REVIEW);
  return {
    state: 'ready',
    commits,
    ops,
    items: [item({ change: 'modified', kind: 'file', path: REVIEW, before: latestReview, after: textVersion(`${(latestReview.lines ?? []).join('\n')}\nOne more line.`) })],
    metadata: [],
  };
}

// ---- diffs in every state

function diffsHistory(library: FakeLibrary, now: number): VersioningSeed {
  const seed = smallHistory(library, now, 'ready');
  const rows = Array.from({ length: 40_000 }, (_, index) => `row ${String(index + 1)},${String((index * 7919) % 10_007)},ok`);
  const changedRows = rows.map((row, index) => (index % 8 === 3 ? `${row.slice(0, -2)}changed` : row));
  const sameText = (text: string, salt: string): [Version, Version] => [
    { ...textVersion(text), hash: hashOf(`${salt}a${text}`) },
    { ...textVersion(text), hash: hashOf(`${salt}b${text}`) },
  ];
  const [crlf, lf] = sameText(WEEK2_TEXT[1] ?? '', 'endings');
  const [gbk, utf8] = sameText('鸦片战争（1840）是中国近代史的开端。', 'encoding');
  const paragraphs = ['习题 2', '1. 求矩阵的秩。', '2. 解线性方程组。'];
  const big = (size: number): Version => ({ hash: hashOf(`big ${String(size)}`), size, stored: false, pruned: false, lines: null });
  const items: FakeItem[] = [
    item({ change: 'modified', kind: 'file', path: `${CSC}/labs/lab2/data.csv`, before: textVersion(rows.join('\n')), after: textVersion(changedRows.join('\n')) }),
    item({ change: 'modified', kind: 'file', path: `${LINEAR}/习题/习题 2.docx`, before: wordVersion(paragraphs, 39_111, 'bold'), after: wordVersion(paragraphs, 39_420, 'italic') }),
    item({ change: 'modified', kind: 'file', path: WEEK2, before: crlf, after: lf, lineEndings: { before: 'crlf', after: 'lf' } }),
    item({ change: 'modified', kind: 'file', path: `${CHINESE_HISTORY}/课堂笔记.md`, before: gbk, after: utf8, encoding: { before: 'gb18030', after: 'utf8' } }),
    item({ change: 'modified', kind: 'file', path: `${CSC}/a1/starter/test_tree.py`, before: textVersion('def test(): pass'), after: textVersion('def test(): pass\n\u0000\u0001'), content: 'binary' }),
    item({ change: 'modified', kind: 'file', path: `${PHY}/Kinematics.md`, before: textVersion('v = u + at'), after: textVersion('v = u + at; s = ut + ½at²'), content: 'tooLarge' }),
    item({ change: 'modified', kind: 'file', path: 'Personal/Todo.txt', before: big(14.2 * MB), after: big(14.6 * MB) }),
    item({ change: 'modified', kind: 'file', path: `${CSC}/README.md`, before: textVersion('Assignment setup'), after: textVersion('Assignment setup: python -m pytest'), readiness: 'notLocal' }),
    item({ change: 'modified', kind: 'file', path: CHAPTER3, before: textVersion('偏导数'), after: textVersion('偏导数的定义'), readiness: 'unreadable' }),
    item({ change: 'deleted', kind: 'file', path: `${MAT}/Old notes.md`, before: textVersion('Old notes\nfrom week 1\nabout limits') }),
  ];
  return { ...seed, items, metadata: [] };
}

// ---- before the first commit


export type VersioningScenario = 'small' | 'none' | 'long' | 'diffs' | 'readOnly' | 'damaged' | 'aiOff' | 'workspaceLarge';

export function versioningFixture(scenario: VersioningScenario): VersioningFixture {
  const ai: AiSeed = { enabled: scenario !== 'aiOff', hasKey: scenario !== 'aiOff' };
  switch (scenario) {
    case 'small':
    case 'aiOff':
      return { history: (library, now) => smallHistory(library, now, 'ready'), ai };
    case 'readOnly':
      return { history: (library, now) => smallHistory(library, now, 'readOnly'), ai };
    case 'damaged':
      return { history: (library, now) => ({ ...smallHistory(library, now, 'damaged'), items: [], metadata: [] }), ai };
    case 'none':
      return { history: noHistory, ai };
    case 'long':
      return { history: longHistory, ai };
    case 'diffs':
      return { history: diffsHistory, ai };
    case 'workspaceLarge':
      return { history: largeWorkspace, ai };
  }
}
