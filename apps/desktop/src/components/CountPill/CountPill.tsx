import './CountPill.css';

import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../lib/format';

export interface CountPillProps {
  /**
   * A number, with the UI language's separators ("50,000"), or a placeholder shown as it is: "…"
   * while the count loads, "–" while it is unknown (workspace-history handoff §3.1).
   */
  count: number | string;
  /** The accessible text when the pill alone would not say what it counts, like "12 files". */
  label?: string;
}

/** A count in a pill: 18 px, primary-text fill, panel-coloured figures (app-shell handoff §10). */
export function CountPill({ count, label }: CountPillProps) {
  const { i18n } = useTranslation();
  const text = typeof count === 'number' ? formatNumber(count, i18n.language) : count;
  return label === undefined ? (
    <span className="count-pill">{text}</span>
  ) : (
    <span className="count-pill" role="img" aria-label={label}>
      {text}
    </span>
  );
}
