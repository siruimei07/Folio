import { type ReactNode, useId } from 'react';

export interface CardProps {
  /** At `font.size.heading`, 600; names the card's region. */
  title?: string;
  description?: ReactNode;
  /** On the right of the title: a button or a switch. */
  action?: ReactNode;
  /** The card's own content under the title. */
  children?: ReactNode;
}

/**
 * A settings card (app-shell handoff §9 "Content"): the title and its description, a control on
 * the right, then what the card holds.
 */
export function Card({ title, description, action, children }: CardProps) {
  const id = useId();
  return (
    <section className="settings-card" aria-labelledby={title === undefined ? undefined : id}>
      {(title !== undefined || action !== undefined) && (
        <div className="settings-card__header">
          <div className="settings-card__words">
            {title !== undefined && (
              <h4 id={id} className="settings-card__title">
                {title}
              </h4>
            )}
            {description !== undefined && <p className="settings-card__description">{description}</p>}
          </div>
          {action !== undefined && <div className="settings-card__action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export interface RowProps {
  /** The row's label, 600. */
  label: string;
  description?: ReactNode;
  /** The control on the right; it gets the ids of the label and the description. */
  control: (ids: { label: string; description: string | undefined }) => ReactNode;
}

/** One row of a split card: label and description on the left, a control on the right. */
export function Row({ label, description, control }: RowProps) {
  const id = useId();
  const ids = { label: `${id}-label`, description: description === undefined ? undefined : `${id}-description` };
  return (
    <div className="settings-row">
      <div className="settings-row__words">
        <span id={ids.label} className="settings-row__label">
          {label}
        </span>
        {description !== undefined && (
          <p id={ids.description} className="settings-row__description">
            {description}
          </p>
        )}
      </div>
      <div className="settings-row__control">{control(ids)}</div>
    </div>
  );
}

/** A split card (app-shell handoff §9): rows separated by 1 px lines. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="settings-card settings-card--rows">{children}</div>;
}

/** A page's cards, `space.14` apart, scrolling inside the dialog. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="settings-page">{children}</div>;
}
