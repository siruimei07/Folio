import './Tree.css';

import { ChevronDown, ChevronRight, CircleX, Clock, Folder, FolderOpen, TagX } from 'lucide-react';
import { type CSSProperties, memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CourseBadge } from '../../components/CourseBadge/CourseBadge';
import { CourseLabel } from '../../components/CourseLabel/CourseLabel';
import { FileTypeIcon } from '../../components/FileTypeIcon/FileTypeIcon';
import { SelectionIndicator } from '../../components/SelectionIndicator/SelectionIndicator';
import { courseTitle } from '../../lib/courses';
import { formatNumber } from '../../lib/format';
import { nameOf } from '../../lib/paths';
import { SIZE } from '../../tokens/tokens';
import { TagDots, type TagLookup } from '../TagDots';
import type { TreeItem } from './layout';

export interface TreeRowViewProps {
  item: TreeItem;
  selected: boolean;
  /** A count on the right: a quick view's files. */
  count?: number;
  tags: TagLookup;
  /** The name field, while the row is renamed or is a new folder. */
  editor?: ReactNode;
  /** The row is where dragged items or files would go: "Move here" or "Add here". */
  drop?: 'move' | 'add' | null;
}

const QUICK_ICONS = { recent: Clock, untagged: TagX } as const;

function Chevron({ expanded }: { expanded: boolean | undefined }) {
  const Icon = expanded === true ? ChevronDown : ChevronRight;
  return (
    <span className="tree-row__chevron" aria-hidden>
      {expanded !== undefined && <Icon size={SIZE.iconSmall} />}
    </span>
  );
}

/**
 * What a row of the Library tree shows (app-shell handoff §5): quick views with their counts,
 * courses with their badge, label and file count, folders with their icon, files with their type
 * icon and up to three tag dots; indent guides, the selection bar, and the drop target's outline.
 * The `treeitem` around it carries the accessible name and state.
 */
export const TreeRowView = memo(function TreeRowView({ item, selected, count, tags, editor, drop = null }: TreeRowViewProps) {
  const { t, i18n } = useTranslation('library');
  if (item.kind === 'separator') return <div className="tree-separator" />;

  const depth = item.level - 1;
  const guides = Array.from({ length: depth }, (_, guide) => (
    <span key={guide} className="tree-row__guide" style={{ '--guide': guide } as CSSProperties} aria-hidden />
  ));
  const right =
    drop !== null ? (
      <span className="tree-row__drop">{t(drop === 'move' ? 'tree.moveHere' : 'tree.addHere')}</span>
    ) : null;

  let body: ReactNode;
  switch (item.kind) {
    case 'quick': {
      const Icon = QUICK_ICONS[item.view];
      body = (
        <>
          <Chevron expanded={undefined} />
          <Icon aria-hidden size={SIZE.icon} className="tree-row__icon" />
          <span className="tree-row__name" data-menu-anchor>
            {t(`tree.quick.${item.view}`)}
          </span>
          {count !== undefined && <span className="tree-row__count">{formatNumber(count, i18n.language)}</span>}
        </>
      );
      break;
    }
    case 'course':
      body = (
        <>
          <Chevron expanded={item.expanded} />
          <CourseBadge course={item.course} />
          {editor ?? (
            <span
              className="tree-row__name tree-row__name--course"
              title={courseTitle(item.course)}
              data-menu-anchor
            >
              <CourseLabel course={item.course} />
            </span>
          )}
          {editor === undefined &&
            (right ?? <span className="tree-row__count">{formatNumber(item.count ?? item.course.files, i18n.language)}</span>)}
        </>
      );
      break;
    case 'entry': {
      const { row } = item;
      const folder = row.kind === 'folder';
      const FolderIcon = item.expanded === true ? FolderOpen : Folder;
      body = (
        <>
          <Chevron expanded={item.expanded} />
          {folder ? (
            <FolderIcon aria-hidden size={SIZE.icon} className="tree-row__icon" />
          ) : (
            <FileTypeIcon name={row.name} />
          )}
          {editor ?? (
            <span className="tree-row__name" title={row.name} data-menu-anchor>
              {row.name}
            </span>
          )}
          {editor === undefined && (right ?? (!folder && <TagDots ids={row.tags} folderIds={row.folderTags} tags={tags} />))}
        </>
      );
      break;
    }
    case 'newFolder':
      body = (
        <>
          <Chevron expanded={undefined} />
          <Folder aria-hidden size={SIZE.icon} className="tree-row__icon" />
          {editor}
        </>
      );
      break;
    case 'pathFolder':
      body = (
        <>
          <Chevron expanded />
          <FolderOpen aria-hidden size={SIZE.icon} className="tree-row__icon" />
          <span className="tree-row__name" title={item.path} data-menu-anchor>
            {nameOf(item.path)}
          </span>
        </>
      );
      break;
    case 'empty':
      body = <span className="tree-row__empty">{t('tree.empty')}</span>;
      break;
    case 'failed':
      body = (
        <>
          <Chevron expanded={undefined} />
          <CircleX aria-hidden size={SIZE.icon} className="tree-row__icon tree-row__icon--danger" />
          <span className="tree-row__name tree-row__name--danger">{t('tree.failed')}</span>
        </>
      );
      break;
    case 'placeholder':
    case 'loading':
      body = (
        <>
          <Chevron expanded={undefined} />
          <span className="tree-row__placeholder" aria-hidden />
        </>
      );
      break;
  }

  return (
    <div
      className="tree-row"
      data-kind={item.kind}
      data-selected={selected || undefined}
      data-drop={drop ?? undefined}
      style={{ '--depth': depth } as CSSProperties}
    >
      {guides}
      {selected && drop === null && <SelectionIndicator />}
      {body}
    </div>
  );
});
