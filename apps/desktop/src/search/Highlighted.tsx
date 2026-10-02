import type { Span } from '../ipc';

/**
 * Spans as text, the matched ones in `<mark>` (UI architecture §9): React escapes every span, so
 * a name or snippet is never parsed as HTML (§14 rule 1).
 */
export function Highlighted({ spans }: { spans: readonly Span[] }) {
  return spans.map((span, index) =>
    span.matched ? (
      <mark key={index} className="search-mark">
        {span.text}
      </mark>
    ) : (
      span.text
    ),
  );
}
