// One line of a text or Word diff (handoff workspace-history §6.3, §6.4): the old and the new
// number, the sign, then the text with its changed words marked. Numbers and signs are hidden
// from screen readers, which hear "Added line" or "Removed line" before the text instead; the
// marks are only for sighted comparison, so the line still reads as one piece of text.
import { memo } from 'react';

import type { DiffRow, TextRange } from '../../ipc';
import { SkeletonLineParts } from '../DiffStates';

/** A row of the folded diff that is a line: unchanged, removed or added. */
export type LineRow = Exclude<DiffRow, { kind: 'fold' }>;

/** A piece of a line's text: marked when it is part of a changed word. */
export interface LinePart {
  text: string;
  marked: boolean;
}

/**
 * The text cut at its marks (ranges in UTF-16 code units, `end` exclusive), in order. Ranges out
 * of the text are clipped, empty ones dropped, and overlapping or touching ones merged, so a range
 * the shell got wrong can neither lose text nor show it twice.
 */
export function lineParts(text: string, marks: readonly TextRange[]): LinePart[] {
  const ranges = marks
    .map((range) => ({
      start: Math.min(Math.max(range.start, 0), text.length),
      end: Math.min(Math.max(range.end, 0), text.length),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const parts: LinePart[] = [];
  let at = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, at);
    if (range.end <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    const last = parts.at(-1);
    const piece = text.slice(start, range.end);
    if (last?.marked === true) last.text += piece;
    else parts.push({ text: piece, marked: true });
    at = range.end;
  }
  if (at < text.length || parts.length === 0) parts.push({ text: text.slice(at), marked: false });
  return parts;
}

export interface DiffLineProps {
  row: LineRow;
  /** "+" or "−" for a changed line, empty for an unchanged one. */
  sign: string;
  /** The visually hidden "Added line" / "Removed line"; `null` for an unchanged line. */
  label: string | null;
  /** A line of the current change (§6.3): the bar at its left edge. */
  current?: boolean;
}

/** A line of the region. Memoised: rows are the query's own objects, so scrolling renders only new lines. */
export const DiffLine = memo(function DiffLine({ row, sign, label, current = false }: DiffLineProps) {
  const old = row.kind === 'added' ? null : row.old;
  const next = row.kind === 'removed' ? null : row.new;
  const parts = row.kind === 'context' ? null : lineParts(row.text, row.marks);
  return (
    <div className="diff-line" data-kind={row.kind} data-current={current || undefined}>
      <span className="diff-line__number" aria-hidden>
        {old}
      </span>
      <span className="diff-line__number" data-side="new" aria-hidden>
        {next}
      </span>
      <span className="diff-line__sign" aria-hidden>
        {sign}
      </span>
      <span className="diff-line__text">
        {/* The space keeps the label a word of its own wherever a screen reader joins the text. */}
        {label !== null && (
          <span className="diff-line__label visually-hidden">
            {label}
            {' '}
          </span>
        )}
        {parts === null
          ? row.text
          : parts.map((part, index) =>
              part.marked ? (
                <span key={index} className="diff-line__mark">
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )}
      </span>
    </div>
  );
});

/** A line whose window has not answered yet (§6.5): two number stubs and a bar, as the loading skeleton. */
export const PendingLine = memo(function PendingLine({ index }: { index: number }) {
  return (
    <div className="diff-skeleton__line" aria-hidden>
      <SkeletonLineParts index={index} />
    </div>
  );
});
