import { useState } from 'react';

/**
 * Counts the openings of a dialog that stays mounted while closed (DialogHost keeps it for its
 * closing animation): key what should start afresh each time, like a half-typed name, by it.
 */
export function useOpening(isOpen: boolean): number {
  const [opening, setOpening] = useState(isOpen ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setOpening(opening + 1);
  }
  return opening;
}

/**
 * The page a settings dialog shows. Each opening starts on `asked` when it names a page, else on
 * the page shown last (UI architecture §6.1: the last settings page). `opening` is `useOpening`'s.
 */
export function usePageOnOpen<Id extends string>(
  pages: readonly [Id, ...Id[]],
  isOpen: boolean,
  asked: string | undefined,
) {
  const isPage = (value: string | undefined): value is Id => pages.some((page) => page === value);
  const [page, setPage] = useState<Id>(() => (isPage(asked) ? asked : pages[0]));
  const opening = useOpening(isOpen);
  const [seen, setSeen] = useState(opening);
  if (opening !== seen) {
    setSeen(opening);
    if (isPage(asked)) setPage(asked);
  }
  return { page, setPage, opening };
}
