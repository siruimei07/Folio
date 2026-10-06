// The rows of the region that are not lines (handoff workspace-history §6.5): a fold, which
// shows the unchanged lines it hides in place, and a window of rows that could not load, which
// offers to try again. Both are bars across the region on the sunken surface.
import { CircleX, RefreshCw, UnfoldVertical } from 'lucide-react';
import { memo } from 'react';
import { Button as AriaButton } from 'react-aria-components';

import { Button } from '../../components/Button/Button';
import { SIZE } from '../../tokens/tokens';
import type { FoldRow as Fold } from '../model/rows';

export interface FoldRowProps {
  /** The fold's row in the folded diff. */
  index: number;
  fold: Fold;
  /** "Show 7 unchanged lines". */
  label: string;
  /** Opens the fold; the region keeps the focus, since this row goes. */
  onUnfold: (index: number, fold: Fold) => void;
}

/** A fold: "Show 7 unchanged lines", which turns into those lines where it is. */
export const FoldRow = memo(function FoldRow({ index, fold, label, onUnfold }: FoldRowProps) {
  return (
    <div className="diff-bar">
      <AriaButton
        className="diff-fold"
        onPress={() => {
          onUnfold(index, fold);
        }}
      >
        <UnfoldVertical aria-hidden size={SIZE.iconSmall} className="diff-fold__icon" />
        <span className="diff-fold__label">{label}</span>
      </AriaButton>
    </div>
  );
});

export interface FailedRowProps {
  /** "Couldn't load these lines." */
  text: string;
  /** "Try again". */
  retryLabel: string;
  /** Fetches the windows that failed again. */
  onRetry: () => void;
}

/** A window of rows whose first fetch failed, as one row (the Library's failed-page pattern). */
export const FailedRow = memo(function FailedRow({ text, retryLabel, onRetry }: FailedRowProps) {
  return (
    <div className="diff-bar" data-failed>
      <span className="diff-bar__failed">
        <CircleX aria-hidden size={SIZE.iconSmall} className="diff-bar__icon" />
        <span>{text}</span>
      </span>
      <Button variant="link" size="compact" icon={RefreshCw} onPress={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
});
