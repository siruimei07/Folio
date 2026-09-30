import '../motion.css';
import '../tone.css';
import './StateBlock.css';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { SIZE } from '../../tokens/tokens';

export interface StateBlockProps {
  /** neutral for empty states; the feedback tones for errors, problems and results. */
  tone?: 'neutral' | 'danger' | 'warning' | 'success';
  icon: LucideIcon;
  /** Turns the icon, for waiting states such as "Reading your library…"; still under reduced motion. */
  spinning?: boolean;
  title: string;
  text?: ReactNode;
  /** Buttons, `space.8` apart. */
  actions?: ReactNode;
  /** A small line under the buttons. */
  hint?: ReactNode;
  /**
   * panel: in the tree or a list, 96 px below the top; preview: centred on the preview's dot grid
   * (empty states) or the sunken surface (errors), 400 px wide.
   */
  placement?: 'panel' | 'preview';
}

/**
 * An empty or error state inside a panel or dialog (library-actions handoff §2.5): a tile with a
 * large icon, the title and text, then buttons and a hint.
 */
export function StateBlock({
  tone = 'neutral',
  icon: Icon,
  spinning = false,
  title,
  text,
  actions,
  hint,
  placement = 'panel',
}: StateBlockProps) {
  return (
    <div className="state-block" data-tone={tone} data-placement={placement}>
      <div className="state-block__tile" aria-hidden>
        <Icon size={SIZE.iconLarge} className={spinning ? 'state-block__icon spinning' : 'state-block__icon'} />
      </div>
      <div className="state-block__words">
        <h3 className="state-block__title">{title}</h3>
        {text !== undefined && <p className="state-block__text">{text}</p>}
      </div>
      {actions !== undefined && <div className="state-block__actions">{actions}</div>}
      {hint !== undefined && <p className="state-block__hint">{hint}</p>}
    </div>
  );
}
