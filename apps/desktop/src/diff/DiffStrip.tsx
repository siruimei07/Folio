import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useShortcutLabel } from '../app/shortcuts';
import { IconButton } from '../components/IconButton/IconButton';
import { useLoadingDelay } from '../components/Skeleton/Skeleton';
import { type DiffStrip as Strip, renderMessage } from './model/describe';
import { type ChangeNavigation, NEXT_CHANGE_KEYS, PREVIOUS_CHANGE_KEYS } from './useChangeNavigation';

/**
 * The summary strip under the header (handoff §6.2): what is compared and the counts, one line cut
 * with an ellipsis and the whole text in the tooltip; on the right, for lines, "Change 2 of 5" and
 * the previous and next buttons. While the diff loads, a skeleton bar after 150 ms; the strip keeps
 * its height meanwhile, so nothing below it moves when the diff arrives.
 */
export function DiffStrip({ strip, navigation = null }: { strip: Strip; navigation?: ChangeNavigation | null }) {
  const { t } = useTranslation(['diff', 'common']);
  if (strip.kind === 'loading') {
    return (
      <div className="diff-strip">
        <StripSkeleton />
      </div>
    );
  }
  const text = strip.parts.map((part) => renderMessage(t, part)).join(t('strip.separator'));
  return (
    <div className="diff-strip">
      <p className="diff-strip__text" title={text}>
        {text}
      </p>
      {navigation !== null && navigation.changes > 0 && <StripNavigation navigation={navigation} />}
    </div>
  );
}

/**
 * "Change 2 of 5" and two 24 px buttons with their F7 hints, disabled at the ends. A button that
 * turns disabled under the focus hands it to the other one, so the keyboard stays in the strip.
 * Moves are announced by the pane, so the position is not a live region.
 */
function StripNavigation({ navigation }: { navigation: ChangeNavigation }) {
  const { t } = useTranslation('diff');
  const shortcut = useShortcutLabel();
  const { current, changes, previous, next } = navigation;
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const first = previous === null;
  const last = next === null;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (last && focused === nextRef.current) previousRef.current?.focus();
    else if (first && focused === previousRef.current) nextRef.current?.focus();
  }, [first, last]);
  return (
    <div className="diff-strip__navigation">
      <span className="diff-strip__position">{t('navigation.position', { current: current + 1, total: changes })}</span>
      <IconButton
        ref={previousRef}
        icon={ChevronUp}
        label={t('navigation.previous')}
        shortcut={shortcut(PREVIOUS_CHANGE_KEYS)}
        size="small"
        isDisabled={first}
        onPress={() => {
          previous?.();
        }}
      />
      <IconButton
        ref={nextRef}
        icon={ChevronDown}
        label={t('navigation.next')}
        shortcut={shortcut(NEXT_CHANGE_KEYS)}
        size="small"
        isDisabled={last}
        onPress={() => {
          next?.();
        }}
      />
    </div>
  );
}

function StripSkeleton() {
  const visible = useLoadingDelay();
  return visible ? <span className="skeleton__bar diff-strip__skeleton" aria-hidden /> : null;
}
