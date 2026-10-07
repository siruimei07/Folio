import { X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { IconButton } from '../components/IconButton/IconButton';
import { PathText } from '../components/PathHeading/PathHeading';
import { useCourses } from '../data/groups';
import type { Course } from '../ipc';
import { nameOf, parentOf } from '../lib/paths';
import { headingPrefix } from '../lib/places';

const NO_COURSES: readonly Course[] = [];

export interface FileFilterChipProps {
  /** The file's path below the library root. */
  path: string;
  /** "Show the whole history", or Esc on the chip. */
  onRemove: () => void;
}

/**
 * The file filter chip after "History" in one file's history (handoff workspace-history §7.1, §7.4):
 * the file's icon, its course code and folders in the tertiary colour and its name in 600, cut from
 * the left like a path heading, then the remove button "Show the whole history". Esc on it shows the
 * whole history too.
 */
export function FileFilterChip({ path, onRemove }: FileFilterChipProps) {
  const { t } = useTranslation('history');
  const courses = useCourses().data ?? NO_COURSES;
  const name = nameOf(path);
  const { label, folders } = headingPrefix(parentOf(path), courses);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onRemove();
  };
  return (
    <div className="file-chip" onKeyDown={onKeyDown}>
      <span className="file-chip__icon" aria-hidden>
        <FileTypeIcon name={name} />
      </span>
      <PathText label={label} prefix={folders} name={name} />
      <IconButton size="small" icon={X} label={t('file.showWhole')} onPress={onRemove} />
    </div>
  );
}
