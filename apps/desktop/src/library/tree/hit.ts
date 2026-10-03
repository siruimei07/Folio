// Which row of the Library tree is under a point, for dragging rows (library-actions §7.3) and
// files from File Explorer (§3). Pointer events and the shell's drop positions are both in CSS
// pixels of the window.

/** The index of the tree row under (x, y), or `null` when the point is on no row of `count`. */
export function treeIndexAt(x: number, y: number, count: number): number | null {
  const row = document.elementFromPoint(x, y)?.closest('.library-tree [data-index]');
  const index = row === null || row === undefined ? NaN : Number(row.getAttribute('data-index'));
  return Number.isInteger(index) && index < count ? index : null;
}
