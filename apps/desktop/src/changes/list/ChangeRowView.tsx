import { CloudOff, FileCog, Folder, FolderOpen, Info, Lock, type LucideIcon, Settings, Tag, Tags } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ChangeStatusIcon } from '../../components/ChangeStatusIcon/ChangeStatusIcon';
import { CheckboxMark, type CheckState } from '../../components/Checkbox/Checkbox';
import { CourseBadge } from '../../components/CourseBadge/CourseBadge';
import { FileTypeIcon } from '../../components/FileTypeIcon/FileTypeIcon';
import { PathText } from '../../components/PathHeading/PathHeading';
import { SelectionIndicator } from '../../components/SelectionIndicator/SelectionIndicator';
import { SIZE } from '../../tokens/tokens';
import type { PlaceText, RowIcon, RowMark, RowText } from './describe';

const ICONS: Readonly<Record<Exclude<RowIcon['kind'], 'file'>, LucideIcon>> = {
  folder: Folder,
  folderOpen: FolderOpen,
  tag: Tag,
  settings: Settings,
  tags: Tags,
  fileCog: FileCog,
};

const MARKS: Readonly<Record<RowMark, LucideIcon>> = { tags: Tag, notLocal: CloudOff, unreadable: Lock };

function RowIconView({ icon }: { icon: RowIcon }) {
  if (icon.kind === 'file') return <FileTypeIcon name={icon.name} />;
  const Icon = ICONS[icon.kind];
  return <Icon size={SIZE.icon} />;
}

/** An item's check box (§3.2, §3.4): on, off, or on and disabled for a required item. */
export interface RowBox {
  state: CheckState;
  disabled: boolean;
  /** Why it cannot change, in its tooltip. */
  reason: string | null;
  onPress: (event: MouseEvent<HTMLSpanElement>) => void;
}

export interface ChangeRowViewProps {
  text: RowText;
  selected: boolean;
  /** An item's box; `null` for a tag or settings change, whose column stays empty. */
  box: RowBox | null;
  /** The id of the row's description (`RowText.description`). */
  descriptionId: string;
}

/**
 * A row of the changes list (workspace-history handoff §3.2–§3.4): the check box, the icon, the
 * path with the course code kept whole, the "Tags" tag, the count, the marks and the change status.
 * The list's option around it carries the name, the selection and the check state.
 */
export function ChangeRowView({ text, selected, box, descriptionId }: ChangeRowViewProps) {
  const { t } = useTranslation('changes');
  const marks: Record<RowMark, string> = { tags: t('rows.tagsChanged'), notLocal: t('rows.notLocal'), unreadable: t('rows.unreadable') };
  return (
    <div
      className="change-row"
      data-selected={selected || undefined}
      data-deleted={text.deleted || undefined}
      data-blocked={text.marks.some((mark) => mark !== 'tags') || undefined}
    >
      {selected && <SelectionIndicator />}
      {box === null ? (
        <span className="change-row__no-box" />
      ) : (
        <span className="change-row__box" title={box.reason ?? undefined}>
          <CheckboxMark state={box.state} isDisabled={box.disabled} onPress={box.onPress} />
        </span>
      )}
      <span className="change-row__icon" aria-hidden>
        <RowIconView icon={text.icon} />
      </span>
      <PathText {...text.path} title={text.title} />
      {text.tagsTag && <span className="change-row__tag">{t('rows.tags')}</span>}
      {text.count !== null && <span className="change-row__count">{text.count}</span>}
      {text.marks.map((mark) => {
        const Mark = MARKS[mark];
        return (
          <span key={mark} className="change-row__mark" data-mark={mark} title={marks[mark]}>
            <Mark aria-hidden size={SIZE.iconSmall} />
          </span>
        );
      })}
      <span className="change-row__status">
        <ChangeStatusIcon status={text.status} />
      </span>
      {text.description !== null && (
        <span id={descriptionId} hidden>
          {text.description}
        </span>
      )}
    </div>
  );
}

/** A row whose page has not arrived. */
export function PlaceholderRow() {
  return (
    <div className="change-row" aria-hidden>
      <span className="change-row__placeholder" />
    </div>
  );
}

export interface PlaceHeaderRowProps {
  text: PlaceText;
  box: RowBox;
  /** The id of the header's description (`PlaceText.description`). */
  descriptionId: string;
}

/**
 * A place's header when grouped by course (§3.5): its check box for every change in it, the
 * course's badge, code and name (or the semester's name, or "Library"), and on the right what the
 * box covers. The list's option around it carries the name and the check state.
 */
export function PlaceHeaderRow({ text, box, descriptionId }: PlaceHeaderRowProps) {
  return (
    <div className="changes-place-header">
      <span className="change-row__box" title={box.reason ?? undefined}>
        <CheckboxMark state={box.state} isDisabled={box.disabled} onPress={box.onPress} />
      </span>
      {text.badge !== null && <CourseBadge course={text.badge} size="compact" />}
      <span className="changes-place-header__code" data-alone={text.name === '' || undefined}>
        {text.code}
      </span>
      {text.name !== '' && <span className="changes-place-header__name">{text.name}</span>}
      {text.count !== null && <span className="changes-place-header__count">{text.count}</span>}
      <span id={descriptionId} hidden>
        {text.description}
      </span>
    </div>
  );
}

/** "Tags and settings" (§3.3): the header of the tag and settings changes, which every commit records. */
export function MetadataHeaderRow() {
  const { t } = useTranslation('changes');
  return (
    <div className="changes-group-header">
      <span className="changes-group-header__title">{t('group.metadata')}</span>
      <span className="changes-group-header__always" title={t('group.alwaysTip')}>
        <Info aria-hidden size={SIZE.iconSmall} />
        {t('group.always')}
      </span>
    </div>
  );
}
