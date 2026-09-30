import './ChangeStatusIcon.css';

import { useTranslation } from 'react-i18next';

import { SIZE } from '../../tokens/tokens';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** Glyphs on the 16 × 16 grid (design/tokens/README.md "Change status icons"). */
const GLYPHS: Readonly<Record<ChangeStatus, string>> = {
  added: 'M8 5v6M5 8h6',
  modified: 'M5.5 10.5l5-5',
  deleted: 'M5 8h6',
  renamed: 'M4.5 8h6.5M8.5 5.5L11 8l-2.5 2.5',
};

/**
 * A change's status as an outlined square with a glyph in the status colour (app-shell handoff
 * 20A): an image named "Added", "Modified", "Deleted" or "Renamed", with the same tooltip.
 */
export function ChangeStatusIcon({ status }: { status: ChangeStatus }) {
  const { t } = useTranslation('common');
  const label = t(`changeStatus.${status}`);
  return (
    <svg
      className="change-status-icon"
      data-status={status}
      role="img"
      aria-label={label}
      width={SIZE.statusIcon}
      height={SIZE.statusIcon}
      viewBox="0 0 16 16"
    >
      <title>{label}</title>
      <rect className="change-status-icon__frame" x="1.75" y="1.75" width="12.5" height="12.5" rx="3" />
      <path className="change-status-icon__glyph" d={GLYPHS[status]} />
    </svg>
  );
}
