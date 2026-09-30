import './Skeleton.css';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LOADING_DELAY_MS } from '../../lib/timing';

/** Widths of the placeholder bars, so the rows do not look like one block. */
const WIDTHS = ['72%', '54%', '64%', '46%', '58%'] as const;

/**
 * Loading rows: nothing for the first 150 ms, so a fast page never flashes, then row-height
 * placeholder bars (UI architecture §13). Announced once as "Loading…".
 */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  const { t } = useTranslation('common');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, LOADING_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  if (!visible) return null;
  return (
    <div className="skeleton" role="status" aria-label={t('loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton__row" aria-hidden>
          <span className="skeleton__bar" style={{ width: WIDTHS[index % WIDTHS.length] }} />
        </span>
      ))}
    </div>
  );
}
