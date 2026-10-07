import { useTranslation } from 'react-i18next';

import { useLoadingDelay } from '../../components/Skeleton/Skeleton';

/** The placeholder entries: the title bar's width and the card outline's height (the canvas's skeleton). */
const ENTRIES = [
  { title: '70%', card: 'tall' },
  { title: '52%', card: 'row' },
  { title: '64%', card: 'taller' },
  { title: '44%', card: 'row' },
] as const;

/**
 * The timeline while its first page loads (handoff workspace-history §7.5): nothing for 150 ms,
 * then a day header stub and entries of a time stub, an icon dot, a title bar and a card outline.
 * Announced once as "Loading the history"; nothing moves while it waits.
 */
export function TimelineSkeleton() {
  const { t } = useTranslation('history');
  const visible = useLoadingDelay();
  if (!visible) return null;
  return (
    <div className="timeline-skeleton" role="status" aria-label={t('states.loading')}>
      <span className="timeline-skeleton__day" aria-hidden />
      {ENTRIES.map((entry, index) => (
        <span key={index} className="timeline-skeleton__entry" aria-hidden>
          <span className="timeline-skeleton__time" />
          <span className="timeline-skeleton__dot" />
          <span className="timeline-skeleton__content">
            <span className="timeline-skeleton__title" style={{ width: entry.title }} />
            <span className="timeline-skeleton__card" data-size={entry.card} />
          </span>
        </span>
      ))}
    </div>
  );
}
