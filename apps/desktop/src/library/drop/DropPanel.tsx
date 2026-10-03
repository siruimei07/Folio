import './DropPanel.css';

import { Import } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLayout } from '../../app/layout';
import { useCourses } from '../../data/groups';
import { courseLabel } from '../../lib/courses';
import { placeOf } from '../../lib/places';
import { SIZE } from '../../tokens/tokens';
import { useLibraryView } from '../state';
import { type DropTarget, useFileDropState } from './useFileDrop';

/** The panel target's title and text: a course, a folder, or none yet (§3). */
function useWords(target: DropTarget | null): { title: string; text: string } {
  const { t } = useTranslation('import');
  const courses = useCourses().data ?? [];
  const folder = target?.folder ?? null;
  if (folder === null) return { title: t('drop.noneTitle'), text: t('drop.noneText') };
  const course = courses.find((candidate) => candidate.folder.id === folder.id);
  return course === undefined
    ? { title: t('drop.title', { target: placeOf(folder.path, courses) }), text: t('drop.folderText') }
    : { title: t('drop.title', { target: courseLabel(course) }), text: t('drop.courseText') };
}

/**
 * The drop target over a whole panel (library-actions handoff §3): a wash with a dashed outline
 * and a card that says where the files go. It shows on the preview, or on whichever panel a
 * narrow window shows, and fades out when the drag leaves. Pointer only, so hidden from screen
 * readers: "Add files" is the keyboard's way.
 */
export function DropPanel({ region }: { region: 'pane' | 'panel' }) {
  const target = useFileDropState((state) => state.target);
  const narrow = useLayout() === 'narrow';
  const covered = useLibraryView((state) => state.covered);
  const visible = narrow ? (covered ? 'pane' : 'panel') : 'pane';
  const shown = target?.kind === 'panel' && region === visible;
  // The last target stays in the card while it fades out.
  const [last, setLast] = useState<DropTarget | null>(null);
  if (shown && target !== last) setLast(target);
  const words = useWords(shown ? target : last);

  return (
    <div className="drop-panel" data-visible={shown || undefined} aria-hidden>
      <div className="drop-panel__frame">
        <div className="drop-panel__card">
          <span className="drop-panel__tile">
            <Import size={SIZE.iconLarge} />
          </span>
          <span className="drop-panel__words">
            <span className="drop-panel__title">{words.title}</span>
            <span className="drop-panel__text">{words.text}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
