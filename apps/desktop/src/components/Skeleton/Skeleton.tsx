import './Skeleton.css';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LOADING_DELAY_MS } from '../../lib/timing';

/** Widths of the placeholder bars, so the rows do not look like one block. */
const WIDTHS = ['72%', '54%', '64%', '46%', '58%'] as const;

/** The width of placeholder bar `index`, for skeletons of their own shape too (`.skeleton__bar`). */
export function skeletonWidth(index: number): string {
  return WIDTHS[index % WIDTHS.length] ?? WIDTHS[0];
}

/**
 * Whether a loading state may show yet: `false` for the first 150 ms after the component mounts,
 * so a fast answer never flashes a placeholder (UI architecture §13). For skeletons of their own
 * shape, such as the diff pane's lines; remount (a `key`) to start the wait again.
 */
export function useLoadingDelay(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, LOADING_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  return visible;
}

/**
 * Loading rows: nothing for the first 150 ms, so a fast page never flashes, then row-height
 * placeholder bars (UI architecture §13). Announced once as "Loading…".
 */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  const { t } = useTranslation('common');
  const visible = useLoadingDelay();
  if (!visible) return null;
  return (
    <div className="skeleton" role="status" aria-label={t('loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton__row" aria-hidden>
          <span className="skeleton__bar" style={{ width: skeletonWidth(index) }} />
        </span>
      ))}
    </div>
  );
}
