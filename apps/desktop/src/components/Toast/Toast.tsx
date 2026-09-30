import '../tone.css';
import './Toast.css';

import { X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../Button/Button';
import { TOP_LAYER_ATTRIBUTE } from '../Dialog/Dialog';
import { type Tone, ToneIcon } from '../feedback';
import { IconButton } from '../IconButton/IconButton';
import { ProgressBar, Spinner } from '../Progress/Progress';

export type ToastTone = Tone | 'progress';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastProps {
  tone: ToastTone;
  title: string;
  body?: string;
  /** A bar under the text: 0–100, or `null` for unknown progress. */
  progress?: number | null;
  actions?: readonly ToastAction[];
  /** "Dismiss" closes the toast; "Hide" (progress toasts) keeps the job running. */
  onDismiss: () => void;
  dismissLabel?: 'dismiss' | 'hide';
  /** Called with `true` while the pointer or focus is inside, so a timer can wait. */
  onHold?: (held: boolean) => void;
  /** Fading out (`motion.duration.fast`); it no longer speaks to screen readers. */
  leaving?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A toast (library-actions handoff §2.4): a tone icon, the title and body, an optional bar and
 * link buttons, and a close button. Errors are alerts, the others status messages; a toast never
 * takes focus.
 */
export function Toast({
  tone,
  title,
  body,
  progress,
  actions = [],
  onDismiss,
  dismissLabel = 'dismiss',
  onHold,
  leaving = false,
  ref,
}: ToastProps) {
  const { t } = useTranslation('common');
  return (
    <div
      ref={ref}
      className="toast"
      data-tone={tone}
      data-leaving={leaving || undefined}
      role={leaving ? undefined : tone === 'danger' ? 'alert' : 'status'}
      onPointerEnter={() => onHold?.(true)}
      onPointerLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHold?.(false);
      }}
    >
      {tone === 'progress' ? (
        <Spinner className="toast__icon" />
      ) : (
        <ToneIcon tone={tone} className="toast__icon" />
      )}
      <div className="toast__body">
        <p className="toast__title">{title}</p>
        {body !== undefined && <p className="toast__text">{body}</p>}
        {progress !== undefined && (
          <div className="toast__progress">
            <ProgressBar label={title} value={progress} />
          </div>
        )}
        {actions.length > 0 && (
          <div className="toast__actions">
            {actions.map((action) => (
              <Button key={action.label} variant="link" onPress={action.onPress}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton icon={X} label={t(dismissLabel)} size="small" tooltipPlacement="top" onPress={onDismiss} />
    </div>
  );
}

/**
 * The toasts' region: bottom right, newest at the bottom (library-actions handoff §2.4). Stays in
 * the page while empty, so screen readers hear the first toast that arrives, and stays usable
 * over dialogs.
 */
export function ToastStack({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="toast-stack" aria-label={label} {...{ [TOP_LAYER_ATTRIBUTE]: '' }}>
      {children}
    </section>
  );
}
