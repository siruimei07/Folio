// Runs inside the sandboxed preview frame (preview.html). It only ever listens to the window
// that embeds it. Spike: plain text only; the Office and PDF renderers come with spike 4c.
import { type PreviewResponse, isPreviewRequest } from './protocol';

// No CSP directive covers WebRTC, which can reach the internet and the local network (ADR-0001
// action item 5). The frame's CSP already stops markup from running script; removing the entry
// point too means a renderer bug cannot open peer connections either.
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
  Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !isPreviewRequest(event.data)) return;
  const text = document.createElement('pre');
  text.textContent = new TextDecoder().decode(event.data.bytes);
  document.body.replaceChildren(text);
  const response: PreviewResponse = { kind: 'rendered' };
  // The window's origin differs between dev and release builds, and the answer carries no data.
  window.parent.postMessage(response, '*');
});
