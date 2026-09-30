import '../tone.css';
import './Banner.css';

import { type LucideIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SIZE } from '../../tokens/tokens';
import { TONE_ICONS, type Tone } from '../feedback';
import { IconButton } from '../IconButton/IconButton';

export interface BannerProps {
  tone: Tone;
  /** Replaces the tone's icon, like `lock` for a read-only library. */
  icon?: LucideIcon;
  /**
   * panel: at the top of a panel, the lead-in and the text on one line; block: in dialogs and
   * first-run pages, the title above the text and buttons below.
   */
  size?: 'panel' | 'block';
  /** The lead-in sentence (panel) or title (block), in 600. */
  title: string;
  text?: ReactNode;
  /** Buttons under the text (block banners). */
  actions?: ReactNode;
  /**
   * true for a banner that appears after an action: danger banners are alerts, the others
   * status messages. A banner present when its view opens is read in place.
   */
  announce?: boolean;
  onDismiss?: () => void;
}

/** A message about the state of a panel, dialog or page (library-actions handoff §2.3). */
export function Banner({ tone, icon, size = 'panel', title, text, actions, announce = false, onDismiss }: BannerProps) {
  const { t } = useTranslation('common');
  const Icon = icon ?? TONE_ICONS[tone];
  const role = announce ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className="banner" data-tone={tone} data-size={size} role={role}>
      <Icon aria-hidden size={SIZE.icon} className="banner__icon" />
      <div className="banner__body">
        {size === 'panel' ? (
          <p className="banner__line">
            <strong className="banner__title">{title}</strong> <span className="banner__text">{text}</span>
          </p>
        ) : (
          <>
            <p className="banner__title">{title}</p>
            {text !== undefined && <p className="banner__text">{text}</p>}
          </>
        )}
        {actions !== undefined && <div className="banner__actions">{actions}</div>}
      </div>
      {onDismiss && <IconButton icon={X} label={t('dismiss')} size="small" onPress={onDismiss} />}
    </div>
  );
}
