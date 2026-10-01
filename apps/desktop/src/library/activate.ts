// What clicking a row or pressing Enter on it shows in the third column (app-shell handoff §5): a
// quick view's files, a course's or folder's grid, or a file's preview. In a narrow window the
// third column covers the list for files and quick views (§2), and "Back" uncovers it.
import { useLayout } from '../app/layout';
import { PREVIEW_PANE } from '../app/panes';
import { type Active, setActive, setCovered } from './state';

export function useActivate(): (active: Active) => void {
  const narrow = useLayout() === 'narrow';
  return (active) => {
    setActive(active);
    const covers = active?.kind === 'quick' || (active?.kind === 'file' && PREVIEW_PANE !== null);
    if (narrow && covers) setCovered(true);
  };
}
