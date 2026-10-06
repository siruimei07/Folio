import { Info } from 'lucide-react';

import { ChangeStatusIcon } from '../components/ChangeStatusIcon/ChangeStatusIcon';
import { SIZE } from '../tokens/tokens';
import type { EventBanner } from './model/describe';

/**
 * An event banner (handoff §6.8): what happened to the file in one sentence, after the status icon
 * of what it says. The sentence says it all, so the icon is hidden from screen readers.
 */
export function EventNote({ banner, text }: { banner: EventBanner; text: string }) {
  return (
    <p className="diff-note" role="note">
      <span className="diff-note__icon" aria-hidden>
        <ChangeStatusIcon status={banner.status} />
      </span>
      <span className="diff-note__text">{text}</span>
    </p>
  );
}

/** A note on how the diff is shown, in the event banner's look with the info tone (§6.5: approximate diffs). */
export function InfoNote({ text }: { text: string }) {
  return (
    <p className="diff-note" role="note" data-tone="info">
      <span className="diff-note__icon" aria-hidden>
        <Info size={SIZE.statusIcon} />
      </span>
      <span className="diff-note__text">{text}</span>
    </p>
  );
}
