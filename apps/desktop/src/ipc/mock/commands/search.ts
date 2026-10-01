// Search (docs/specs/ipc-m1.md §10; library core §6), simplified: case-insensitive substrings of
// names, tag names, paths and body text; every word must match somewhere. Ranking: name, then
// tags, then path, then body; ties to the shorter path. The best `searchResults` matches form one
// list per revision, and pages slice it.
import { isInside } from '../../../lib/paths';
import { LIMITS, type SearchHit, type Span } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { checkPage, type FakeLibrary, type FakeNode } from '../library';
import { charCount } from '../names';
import type { FakeShell } from '../shell';

/** Body text around a match: this many UTF-16 units before and after it. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` split into spans, with every occurrence of every term marked. */
export function spans(text: string, terms: string[]): Span[] {
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (const match of text.matchAll(new RegExp(escape(term), 'giu'))) {
      marked.fill(true, match.index, match.index + match[0].length);
    }
  }
  const result: Span[] = [];
  for (let index = 0; index < text.length; index++) {
    const matched = marked[index] ?? false;
    const char = text.charAt(index);
    const last = result.at(-1);
    if (last?.matched === matched) last.text += char;
    else result.push({ text: char, matched });
  }
  return result;
}

function snippet(body: string, terms: string[]): Span[] | null {
  const lower = body.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  if (found.length === 0) return null;
  const first = Math.min(...found);
  let start = Math.max(0, first - SNIPPET_BEFORE);
  let end = Math.min(body.length, first + SNIPPET_AFTER);
  // Never cut a surrogate pair in half.
  if (/[\uDC00-\uDFFF]/.test(body[start] ?? '')) start--;
  if (/[\uD800-\uDBFF]/.test(body[end - 1] ?? '')) end++;
  const text = `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
  return spans(text, terms);
}

/** A file's searchable text, lower case. */
interface Indexed {
  node: FakeNode;
  name: string;
  path: string;
  tags: string;
  body: string;
}

/** The library's files, indexed once per revision and shared by every question asked of it. */
let index: { library: FakeLibrary; revision: number; files: Indexed[] } | null = null;
/** The best matches of the last question, while the revision stays the same. */
let last: { library: FakeLibrary; revision: number; key: string; hits: FakeNode[] } | null = null;

function indexOf(library: FakeLibrary): Indexed[] {
  if (index?.library === library && index.revision === library.revision) return index.files;
  const names = new Map(library.tags.map((tag) => [tag.id, tag.name]));
  const files = library.filesWithTags(library.root).map(({ node, folderTags }) => ({
    node,
    name: node.name.toLowerCase(),
    path: node.path.toLowerCase(),
    tags: [...node.tags, ...folderTags].map((id) => names.get(id) ?? '').join(' ').toLowerCase(),
    body: node.text?.toLowerCase() ?? '',
  }));
  index = { library, revision: library.revision, files };
  return files;
}

function rank(library: FakeLibrary, scope: FakeNode, terms: string[]): FakeNode[] {
  const key = `${scope.id}\n${terms.join('\n')}`;
  if (last?.library === library && last.revision === library.revision && last.key === key) {
    return last.hits;
  }
  const within = scope === library.root ? null : scope.path;
  const ranked: { node: FakeNode; score: number }[] = [];
  for (const file of indexOf(library)) {
    if (!isInside(file.node.path, within)) continue;
    let score = 0;
    let every = true;
    for (const term of terms) {
      const found =
        (file.name.includes(term) ? 10 : 0) +
        (file.tags.includes(term) ? 5 : 0) +
        (file.path.includes(term) ? 3 : 0) +
        (file.body.includes(term) ? 1 : 0);
      if (found === 0) every = false;
      score += found;
    }
    if (every) ranked.push({ node: file.node, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.node.path.length - b.node.path.length);
  const hits = ranked.slice(0, LIMITS.searchResults).map((hit) => hit.node);
  last = { library, revision: library.revision, key, hits };
  return hits;
}

export function searchCommands(shell: FakeShell): GroupHandlers<'search'> {
  return {
    search: (request) => {
      // Checked before anything else (library core §6).
      if (charCount(request.text) > LIMITS.queryChars) fail('QueryTooLong', 'over queryChars');
      const library = shell.library;
      checkPage(request.page);
      if (request.page.offset + request.page.limit > LIMITS.searchResults) {
        fail('InvalidArgument', '`offset + limit` is over LIMITS.searchResults');
      }
      const scope = library.resolveFolder(request.scope);
      const terms = request.text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
      const hits = terms.length === 0 ? [] : rank(library, scope, terms);
      const page = hits.slice(request.page.offset, request.page.offset + request.page.limit);
      const items: SearchHit[] = page.map((node) => ({
        entry: library.row(node),
        name: spans(node.name, terms),
        snippet: node.text === null ? null : snippet(node.text, terms),
      }));
      return {
        items,
        offset: request.page.offset,
        more: request.page.offset + page.length < hits.length,
        revision: library.revision,
      };
    },
  };
}
