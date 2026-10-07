// Where the focus goes when the control that had it went from outside the view showing (a dialog
// closed after what it was opened on had gone) and that view has no focus request of its own for
// it (History's and Changes' are `history/state.ts` focusTimeline and `changeTarget.ts`
// showChange): the rail's button of the view showing (WCAG 2.4.3). It is always in the page,
// names the view, and Tab goes on from it into the view.

/** Puts the focus on the rail's button of the view showing (`Rail.tsx`); returns whether it took it. */
export function focusViewButton(): boolean {
  const button = document.querySelector<HTMLElement>('.rail .rail__button[aria-current="page"]');
  button?.focus();
  return button !== null && document.activeElement === button;
}
