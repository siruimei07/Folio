// The toast queue (library-actions handoff §2.4). Any view shows a toast with `showToast`; the
// app's `ToastRegion` draws them. At most three; a toast with the key of one already shown
// replaces it in place, so a repeat never stacks.

import { create } from 'zustand';

import type { ToastProps, ToastTone } from '../components/Toast/Toast';

export const MAX_TOASTS = 3;

/** What a toast shows (the `Toast` props), and how the queue handles it. */
export interface ToastRequest
  extends Pick<ToastProps, 'tone' | 'title' | 'body' | 'progress' | 'actions' | 'dismissLabel'> {
  /** Replaces the toast with the same key; by default the tone, title and body. */
  key?: string;
  /** Called when the user closes it (not when it times out or is replaced). */
  onDismiss?: () => void;
}

export interface ToastEntry extends ToastRequest {
  key: string;
  /** Changes when a toast is replaced, so its timer starts again. */
  version: number;
  /** Fading out; `ToastRegion` drops it when the fade ends. */
  leaving: boolean;
}

interface ToastState {
  toasts: readonly ToastEntry[];
}

export const useToasts = create<ToastState>()(() => ({ toasts: [] }));

let version = 0;

/** Shows a toast, or replaces the one with the same key. Returns the key. */
export function showToast(request: ToastRequest): string {
  const key = request.key ?? [request.tone, request.title, request.body ?? ''].join('\n');
  version += 1;
  const entry: ToastEntry = { ...request, key, version, leaving: false };
  useToasts.setState(({ toasts }) => {
    const index = toasts.findIndex((toast) => toast.key === key);
    if (index >= 0) return { toasts: toasts.map((toast, at) => (at === index ? entry : toast)) };
    // A fourth pushes out the oldest at once; newest at the bottom.
    const shown = toasts.filter((toast) => !toast.leaving);
    return { toasts: [...shown, entry].slice(-MAX_TOASTS) };
  });
  return key;
}

/** Fades a toast out, for example when its job ends another way. */
export function removeToast(key: string): void {
  useToasts.setState(({ toasts }) => ({
    toasts: toasts.map((toast) => (toast.key === key ? { ...toast, leaving: true } : toast)),
  }));
}

/** Drops a toast whose fade has ended. */
export function dropToast(key: string): void {
  useToasts.setState(({ toasts }) => ({ toasts: toasts.filter((toast) => toast.key !== key) }));
}

/** Whether a toast closes by itself: success and information do; warnings, errors and progress stay. */
export function closesByItself(tone: ToastTone): boolean {
  return tone === 'success' || tone === 'info';
}
