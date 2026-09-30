import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Toast, ToastStack } from '../components/Toast/Toast';
import { TOAST_DISMISS_MS } from '../lib/timing';
import { closesByItself, dropToast, removeToast, type ToastEntry, useToasts } from './toasts';

/** Resolves when the element's animations have ended; at once when it has none (reduced motion). */
function animationsDone(element: HTMLElement | null): Promise<unknown> {
  const animations = typeof element?.getAnimations === 'function' ? element.getAnimations() : [];
  return Promise.allSettled(animations.map((animation) => animation.finished));
}

/** One toast with its timer: success and information close after 6 s unless held. */
function TimedToast({ toast }: { toast: ToastEntry }) {
  const element = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const timed = closesByItself(toast.tone) && !toast.leaving;
  useEffect(() => {
    if (!timed || held) return undefined;
    const timer = window.setTimeout(() => {
      removeToast(toast.key);
    }, TOAST_DISMISS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [timed, held, toast.key, toast.version]);
  useEffect(() => {
    if (!toast.leaving) return undefined;
    let current = true;
    void animationsDone(element.current).then(() => {
      if (current) dropToast(toast.key);
    });
    return () => {
      current = false;
    };
  }, [toast.leaving, toast.key]);
  // `version` goes along unused: it only restarts the timer above.
  const { key, onDismiss, ...shown } = toast;
  return (
    <Toast
      {...shown}
      ref={element}
      onHold={setHeld}
      onDismiss={() => {
        removeToast(key);
        onDismiss?.();
      }}
    />
  );
}

/** The app's toasts, bottom right (library-actions handoff §2.4). Mount once. */
export function ToastRegion() {
  const { t } = useTranslation('shell');
  const toasts = useToasts((state) => state.toasts);
  return (
    <ToastStack label={t('notifications')}>
      {toasts.map((toast) => (
        <TimedToast key={toast.key} toast={toast} />
      ))}
    </ToastStack>
  );
}
