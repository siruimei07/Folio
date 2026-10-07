// The `workspace-large` scenario: 50,000 changes over the large library, for scrolling, paging,
// select-all and grouping at full scale in the browser pane and in tests (handoff
// workspace-history §3.9; ipc-m2 §17). Almost every file of the library was edited since the
// first commit; some were added or moved, and the rest of the 50,000 are deleted scans. Spread
// through the list, as a real workspace would have them: files still hashing, not downloaded,
// unreadable, and bound to a change of the versioning rules (required). The same library gives
// the same workspace every time.
import type { FakeLibrary, FakeNode } from '../library';
import { classOf } from '../order';
import { randomHex } from '../random';
import {
  blobVersion,
  commitId,
  type FakeCommit,
  type FakeItem,
  type FakeMeta,
  item,
  textVersion,
  type Version,
  type VersioningSeed,
} from './model';

export const LARGE_WORKSPACE_ITEMS = 50_000;

const DAY = 86_400_000;
const DEVICE = { id: randomHex(16), name: 'G16' };

/** One commit of the scenario's short history, `daysAgo` before `now`. */
function commit(now: number, daysAgo: number, summary: string): FakeCommit {
  const timeMs = Math.floor((now - daysAgo * DAY) / 1000) * 1000;
  return { id: commitId(), kind: 'commit', timeMs, summary, body: null, device: DEVICE, changes: [], metadata: [], pruned: 0 };
}

/** The version a file had at the first commit, and the one on the disk now. */
function versions(node: FakeNode): { before: Version; after: Version } {
  if (classOf(node.name, 'file') === 'text') {
    const text = node.text ?? `${node.name}\n`;
    return { before: textVersion(text), after: textVersion(`${text}\nEdited since the first commit.`) };
  }
  const size = Number(node.size);
  return { before: blobVersion(Math.max(1, size - 4096), `${node.path}#0`), after: blobVersion(size, node.path) };
}

/** The `index`th file of the library as a workspace item: mostly an edit. */
function fileItem(node: FakeNode, index: number): FakeItem {
  const { before, after } = versions(node);
  const readiness =
    index % 1999 === 29 ? 'unreadable' : index % 997 === 13 ? 'notLocal' : index % 101 === 7 ? 'hashing' : 'ready';
  if (index % 1499 === 41) {
    // The versioning rules changed so that this file is stored now (ipc-m2 §6.2).
    return item({ change: 'modified', kind: 'file', path: node.path, before, after, readiness, required: true, parts: [{ kind: 'versioningRules' }] });
  }
  if (index % 503 === 17) {
    const from = `${node.path.slice(0, node.path.length - node.name.length)}old ${node.name}`;
    return item({ change: 'moved', kind: 'file', path: node.path, fromPath: from, before: after, after, readiness });
  }
  if (index % 211 === 3) return item({ change: 'added', kind: 'file', path: node.path, after, readiness });
  return item({ change: 'modified', kind: 'file', path: node.path, before, after, readiness });
}

export function largeWorkspace(library: FakeLibrary, now: number): VersioningSeed {
  const files = library.walk(library.root).filter((node) => node.kind === 'file');
  const items = files.slice(0, LARGE_WORKSPACE_ITEMS).map(fileItem);
  for (let n = 1; items.length < LARGE_WORKSPACE_ITEMS; n++) {
    const path = `Personal/Old scans/Scan ${String(n).padStart(5, '0')}.pdf`;
    items.push(item({ change: 'deleted', kind: 'file', path, before: blobVersion(200_000 + n * 37, path) }));
  }
  const metadata: FakeMeta[] = [
    {
      key: 'meta:ignoreRules',
      change: 'modified',
      subject: { kind: 'ignoreRules' },
      detail: null,
      text: { before: ['*.log'], after: ['*.log', '*.tmp'] },
    },
  ];
  const course = library.walk(library.root).find((node) => node.kind === 'folder' && node.group?.code != null);
  if (course !== undefined) {
    metadata.unshift({
      key: `meta:course:${course.path}`,
      change: 'modified',
      subject: { kind: 'course', path: course.path, folder: library.refAt(course.path) },
      detail: { kind: 'settings', changes: [{ field: 'color', before: 'teal', after: 'blue' }] },
      text: null,
    });
  }
  const commits = [
    commit(now, 60, 'Start history'),
    commit(now, 30, 'MAT232: add 3 files'),
    commit(now, 2, 'Personal: update 1 file'),
  ];
  return { state: 'ready', commits, ops: [], items, metadata };
}
