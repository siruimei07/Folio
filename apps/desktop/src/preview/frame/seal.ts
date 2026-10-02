// Imported first by the frame's entry (main.ts), so it runs before any renderer exists.
//
// No CSP directive covers WebRTC, which can reach the internet and the local network (ADR-0001
// action item 5). The frame's CSP already stops markup from running script; removing the entry
// point too means a renderer bug cannot open peer connections either.
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
  Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
}
