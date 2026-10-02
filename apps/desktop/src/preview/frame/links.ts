// Links in a preview never navigate (ADR-0005, product decision 2; UI architecture §14 rule 6).
// A `#fragment` scrolls within the note; pdf.js handles its own destinations, which are `#` links
// too. Any other click is cancelled and the window shows the address with "Copy address". Links
// carry their address as a tooltip (markdown.ts; pdf.js sets it).

import { MAX_LINK_CHARS } from '../protocol';
import { send } from './view';

function linkOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('a[href], area[href]') : null;
}

function scrollToFragment(fragment: string): void {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // A malformed escape names nothing; the raw text may still be an id.
  }
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
  target?.scrollIntoView({ block: 'start' });
}

function onClick(event: MouseEvent): void {
  const link = linkOf(event.target);
  if (link === null) return;
  const href = link.getAttribute('href') ?? '';
  event.preventDefault();
  if (href.startsWith('#')) {
    // pdf.js's own handler on the link still runs; a note scrolls to the heading or anchor.
    if (link.closest('.note')) scrollToFragment(href.slice(1));
    return;
  }
  event.stopImmediatePropagation();
  if (event.type !== 'click' || href === '') return;
  const box = link.getBoundingClientRect();
  send({
    kind: 'link',
    href: href.slice(0, MAX_LINK_CHARS),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
}

/** Cancels navigation by every link in the frame, for the frame's whole life. */
export function installLinks(): void {
  document.addEventListener('click', onClick, true);
  // A middle click would open a new window, which the sandbox refuses anyway.
  document.addEventListener('auxclick', onClick, true);
  // A dragged link must not land on the window, whose drop target adds files.
  document.addEventListener(
    'dragstart',
    (event) => {
      if (linkOf(event.target) !== null) event.preventDefault();
    },
    true,
  );
}
