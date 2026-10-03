import './FailureList.css';

import { MiddleTruncate } from '../MiddleTruncate/MiddleTruncate';

export interface FailureItem {
  /** Where the item is, as shown: "MAT232/Problem sets/ps2.pdf". */
  place: string;
  /** Why it failed, in words. */
  reason: string;
}

/**
 * Every item an action could not handle, each with why (library-actions handoff §5 "Details", UI
 * architecture §13: nothing is dropped): the place in 600, truncated in the middle, above the
 * reason. The result dialogs of the Library's batches and of imports share it.
 */
export function FailureList({ label, items }: { label: string; items: readonly FailureItem[] }) {
  return (
    <ul className="failure-list" aria-label={label}>
      {items.map((item, index) => (
        <li key={index} className="failure-list__item">
          <span className="failure-list__place">
            <MiddleTruncate text={item.place} />
          </span>
          <span className="failure-list__reason">{item.reason}</span>
        </li>
      ))}
    </ul>
  );
}
