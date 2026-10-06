import type { TFunction } from 'i18next';
import {
  ArrowLeft,
  Ellipsis,
  Eye,
  FileCog,
  FileDiff,
  Folder,
  FolderOpen,
  type LucideIcon,
  RotateCcw,
  Settings,
  Tag,
  Tags,
} from 'lucide-react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton, Focusable } from 'react-aria-components';

import { Button } from '../components/Button/Button';
import { ChangeStatusIcon, type ChangeStatus } from '../components/ChangeStatusIcon/ChangeStatusIcon';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { IconButton } from '../components/IconButton/IconButton';
import { Menu, MenuButton, MenuItem, MenuSeparator } from '../components/Menu/Menu';
import { PathHeading } from '../components/PathHeading/PathHeading';
import { SegmentedControl } from '../components/SegmentedControl/SegmentedControl';
import { Tooltip } from '../components/Tooltip/Tooltip';
import type { Course } from '../ipc';
import { nameOf, parentOf } from '../lib/paths';
import { headingPrefix } from '../lib/places';
import { SIZE } from '../tokens/tokens';
import { type DiffHeading, type HeadingIcon, renderMessage } from './model/describe';
import type { DiffBack, DiffRestore } from './types';

const ICONS: Readonly<Record<Exclude<HeadingIcon['kind'], 'file'>, LucideIcon>> = {
  folder: Folder,
  folderOpen: FolderOpen,
  tag: Tag,
  settings: Settings,
  tags: Tags,
  fileCog: FileCog,
};

function HeadingIconView({ icon }: { icon: HeadingIcon }) {
  if (icon.kind === 'file') return <FileTypeIcon name={icon.name} />;
  const Icon = ICONS[icon.kind];
  return <Icon size={SIZE.icon} />;
}

/** The course code and the folders before a path's name, as `PathHeading` takes them. */
function placeOfHeading(path: string, courses: readonly Course[]): { label: string; prefix: string } {
  const { label, folders } = headingPrefix(parentOf(path), courses);
  return { label, prefix: folders };
}

/** What the body shows: the diff, or the file at this version through the preview (§6.7). */
export type DiffView = 'changes' | 'version';

/** "Changes | This version": the view shown and how to change it. */
export interface DiffToggle {
  view: DiffView;
  onChange: (view: DiffView) => void;
}

/**
 * "Restore" (§8.1): an outline button, or, with a reason it cannot be done, the shared `Button`'s
 * disabled look on a button that stays in the tab order (`aria-disabled`, handoff §4.2), so the
 * reason in its tooltip is shown on hover and heard on focus. React Aria's disabled button can do
 * neither: it leaves the tab order and gets no hover.
 */
function RestoreButton({ restore }: { restore: DiffRestore }) {
  const { t } = useTranslation('diff');
  const { onRestore, disabledReason } = restore;
  if (disabledReason === undefined) {
    return (
      <Button size="compact" icon={RotateCcw} onPress={onRestore}>
        {t('header.restore')}
      </Button>
    );
  }
  return (
    <Tooltip content={disabledReason}>
      <Focusable>
        <button type="button" className="button" data-variant="outline" data-size="compact" data-disabled aria-disabled="true">
          <RotateCcw aria-hidden size={SIZE.iconSmall} className="button__icon" />
          {t('header.restore')}
        </button>
      </Focusable>
    </Tooltip>
  );
}

/** The items a compact pane adds to "More": the toggle as one item that flips, and "Restore…". */
function paneMenuItems(
  t: TFunction<['diff', 'common']>,
  toggle: DiffToggle | null,
  restore: DiffRestore | undefined,
): ReactElement[] {
  const items: ReactElement[] = [];
  if (toggle !== null) {
    const changes = toggle.view === 'changes';
    items.push(
      <MenuItem
        key="diff-toggle"
        id="diff-toggle"
        icon={changes ? Eye : FileDiff}
        onAction={() => {
          toggle.onChange(changes ? 'version' : 'changes');
        }}
      >
        {changes ? t('header.showVersion') : t('header.showChanges')}
      </MenuItem>,
    );
  }
  if (restore !== undefined) {
    // A disabled item gets no tooltip, and the arrow keys skip it: its reason is its note (§17).
    items.push(
      <MenuItem
        key="diff-restore"
        id="diff-restore"
        icon={RotateCcw}
        isDisabled={restore.disabledReason !== undefined}
        note={restore.disabledReason}
        onAction={restore.onRestore}
      >
        {t('header.restoreMenu')}
      </MenuItem>,
    );
  }
  return items;
}

export interface DiffHeaderProps {
  icon: HeadingIcon;
  heading: DiffHeading;
  status: ChangeStatus;
  courses: readonly Course[];
  back?: DiffBack;
  moreItems?: ReactNode;
  /** "Changes | This version", when this version can be shown (§6.7). */
  toggle: DiffToggle | null;
  restore?: DiffRestore;
  /** The pane is narrower than `size.diff-compact-pane`: the toggle and Restore go into "More". */
  compact: boolean;
  /** The heading's id, which names the pane. */
  headingId: string;
  headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * The diff header (handoff §6.1), known from the row before the diff loads: "Back" in a narrow
 * window, the path heading, the change status, and on the right "Changes | This version",
 * History's "Restore" and "More" (the host's items, and in a compact pane the toggle and
 * "Restore…" after them).
 */
export function DiffHeader({
  icon,
  heading,
  status,
  courses,
  back,
  moreItems,
  toggle,
  restore,
  compact,
  headingId,
  headingRef,
}: DiffHeaderProps) {
  const { t } = useTranslation(['diff', 'common']);
  const title =
    heading.kind === 'path'
      ? {
          ...placeOfHeading(heading.path, courses),
          name: nameOf(heading.path),
          suffix: heading.suffix === null ? undefined : `${t('strip.separator')}${renderMessage(t, heading.suffix)}`,
        }
      : { label: '', prefix: '', name: renderMessage(t, heading.title), suffix: undefined };
  const paneItems = compact ? paneMenuItems(t, toggle, restore) : [];
  const more = moreItems !== undefined || paneItems.length > 0;
  const segmented = !compact && toggle !== null;
  const restoreButton = !compact && restore !== undefined;
  return (
    <header className="diff-header">
      {back !== undefined && (
        <AriaButton className="diff-header__back" aria-label={back.label} onPress={back.onBack}>
          <ArrowLeft aria-hidden size={SIZE.icon} />
          {t('header.back')}
        </AriaButton>
      )}
      <PathHeading icon={<HeadingIconView icon={icon} />} id={headingId} ref={headingRef} {...title} />
      <ChangeStatusIcon status={status} />
      {(segmented || restoreButton || more) && (
        <div className="diff-header__actions">
          {segmented && (
            <SegmentedControl<DiffView>
              label={t('header.show')}
              segments={[
                { id: 'changes', label: t('header.changes') },
                { id: 'version', label: t('header.thisVersion') },
              ]}
              selected={toggle.view}
              onChange={toggle.onChange}
            />
          )}
          {restoreButton && <RestoreButton restore={restore} />}
          {more && (
            <MenuButton placement="bottom end" trigger={<IconButton icon={Ellipsis} label={t('header.more')} />}>
              <Menu>
                {moreItems}
                {moreItems !== undefined && paneItems.length > 0 && <MenuSeparator />}
                {paneItems}
              </Menu>
            </MenuButton>
          )}
        </div>
      )}
    </header>
  );
}
