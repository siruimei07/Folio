import './CountPill.css';

import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../lib/format';

export interface CountPillProps {
  count: number;
  /** The accessible text when the number alone would not say what it counts, like "12 files". */
  label?: string;
}

/** A count in a pill: 18 px, primary-text fill, panel-coloured figures (app-shell handoff §10). */
export function CountPill({ count, label }: CountPillProps) {
  const { i18n } = useTranslation();
  const text = formatNumber(count, i18n.language);
  return label === undefined ? (
    <span className="count-pill">{text}</span>
  ) : (
    <span className="count-pill" role="img" aria-label={label}>
      {text}
    </span>
  );
}
