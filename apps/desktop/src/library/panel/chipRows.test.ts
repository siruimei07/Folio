// What fits in the tag filter bar's two rows (workspace-history handoff §12.1, 33B).
import { describe, expect, it } from 'vitest';

import { visibleTagCount } from './chipRows';

const chips = (count: number, width = 60) => Array.from({ length: count }, () => width);

describe('visibleTagCount', () => {
  it('shows every tag when they fit in two rows', () => {
    // "All" and two tags on the first row, three tags on the second.
    expect(visibleTagCount({ available: 200, gap: 4, first: 40, tags: chips(5), more: 40 })).toBe(5);
  });

  it('moves the tags that would start a third row behind "+N"', () => {
    // Rows of three: All, 1, 2 | 3, 4, 5 | 6 …; "+N" fits after tag 5: 188 + 4 + 40 ≤ 240.
    expect(visibleTagCount({ available: 240, gap: 4, first: 60, tags: chips(9), more: 40 })).toBe(5);
  });

  it('moves the last tag of the second row into the menu when "+N" would not fit beside it', () => {
    // All, 1, 2 | 3, 4, 5 fill both rows exactly; "+N" only fits after tag 4.
    expect(visibleTagCount({ available: 188, gap: 4, first: 60, tags: chips(9), more: 60 })).toBe(4);
  });

  it('puts a tag as wide as the bar behind "+N" when "+N" cannot follow it', () => {
    // The wide tag fills the second row on its own, so the third would start right after it.
    expect(visibleTagCount({ available: 200, gap: 4, first: 40, tags: [500, 60, 60], more: 40 })).toBe(0);
  });

  it('shows everything until the bar has a width', () => {
    expect(visibleTagCount({ available: 0, gap: 4, first: 40, tags: chips(20), more: 40 })).toBe(20);
  });
});
