// The parts of a change row (workspace-history handoff §3.2–§3.4, §7.2; app-shell §7) that the
// Changes list and History's file cards share, and the icon the diff header puts before its path.
// Each view keeps its own row element (its role, handlers, selection bar and Changes' check box)
// and renders these parts inside it.
import './ChangeRow.css';

import { FileCog, Folder, FolderOpen, type LucideIcon, Settings, Tag, Tags } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SIZE } from '../../tokens/tokens';
import { ChangeStatusIcon } from '../ChangeStatusIcon/ChangeStatusIcon';
import { FileTypeIcon } from '../FileTypeIcon/FileTypeIcon';
import { PathText } from '../PathHeading/PathHeading';
import type { ChangeRowFace, ChangeRowIcon } from './words';

const ICONS: Readonly<Record<Exclude<ChangeRowIcon['kind'], 'file'>, LucideIcon>> = {
  folder: Folder,
  folderOpen: FolderOpen,
  tag: Tag,
  settings: Settings,
  tags: Tags,
  fileCog: FileCog,
};

/** The 16 px icon of a change: the file's type icon, or its Lucide icon. Decorative. */
export function ChangeRowIconView({ icon }: { icon: ChangeRowIcon }) {
  if (icon.kind === 'file') return <FileTypeIcon name={icon.name} />;
  const Icon = ICONS[icon.kind];
  return <Icon size={SIZE.icon} />;
}

export interface ChangeRowPartsProps {
  face: ChangeRowFace;
  /** What the view puts between the "Tags" tag and the status, such as the Changes list's count and marks. */
  children?: ReactNode;
}

/**
 * A change row's shared parts, in order and without a container: the icon, the path with the
 * course code kept whole (its tooltip `face.tooltip`), the "Tags" tag of a tag change, the view's
 * own parts, then the change status pushed to the end. Render them in an element with the
 * `change-row` class (and `data-deleted` for a deleted change), which lays them out.
 */
export function ChangeRowParts({ face, children }: ChangeRowPartsProps) {
  const { t } = useTranslation('common');
  return (
    <>
      <span className="change-row__icon" aria-hidden>
        <ChangeRowIconView icon={face.icon} />
      </span>
      <PathText {...face.path} title={face.tooltip} />
      {face.tagsTag && <span className="change-row__tag">{t('changeRow.tags')}</span>}
      {children}
      <span className="change-row__status">
        <ChangeStatusIcon status={face.status} />
      </span>
    </>
  );
}
