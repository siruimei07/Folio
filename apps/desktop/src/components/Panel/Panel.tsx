import './Panel.css';

import { type ReactNode, useId } from 'react';

import { CountPill } from '../CountPill/CountPill';

export interface PanelProps {
  /** The header's title, which also names the panel's region. */
  title: string;
  /** Before the title, such as the Changes list's "Include all changes" check box. */
  leading?: ReactNode;
  /** The count pill after the title: a number, or a placeholder such as "…" (`CountPill`). */
  count?: number | string;
  /** What the count is, for screen readers: "52 files in Fall 2026". */
  countLabel?: string;
  /** Controls on the right of the header: toggles, icon buttons. */
  actions?: ReactNode;
  /** Positions and sizes the panel, like `library-panel`. */
  className?: string;
  children: ReactNode;
}

/**
 * A panel of a view (app-shell handoff §2, §5): the panel surface with a 1 px border and a 44 px
 * header of title, count and controls, then its body. With something before the title, the
 * header starts 6 px in, its parts 6 px apart (workspace-history §3.1).
 */
export function Panel({ title, leading, count, countLabel, actions, className, children }: PanelProps) {
  const titleId = useId();
  return (
    <section className={className === undefined ? 'panel' : `panel ${className}`} aria-labelledby={titleId}>
      <header className="panel__header" data-leading={leading === undefined ? undefined : true}>
        {leading}
        <h2 id={titleId} className="panel__title">
          {title}
        </h2>
        {count !== undefined && <CountPill count={count} label={countLabel} />}
        {actions !== undefined && <div className="panel__actions">{actions}</div>}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
