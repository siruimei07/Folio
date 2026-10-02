// Keys inside the frame (UI architecture §10.5): the window's shortcuts (§6.4: Ctrl+K, Ctrl+1,
// Ctrl+, …) go to the window as `shortcut` messages, so they work while the frame has focus, and
// Esc takes focus back to the preview header. Everything else stays here: scrolling, selecting,
// Ctrl+C and Ctrl+A.

import { isForwardedPress } from '../protocol';
import { send } from './view';

export function installKeys(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      // An IME's keys (Chinese input) say `Process` before composition starts.
      if (event.isComposing || event.key === 'Process') return;
      const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
      const press = { key, ctrlKey, shiftKey, altKey, metaKey };
      if (!isForwardedPress(press)) return;
      event.preventDefault();
      send({ kind: 'shortcut', press });
    },
    true,
  );
}
