import './commit.css';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { type FocusEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/IconButton/IconButton';
import { useShortWindow } from '../windowQuery';
import { MessageIconButton } from './MessageButton';
import {
  AiNoteView,
  BlockLine,
  CommitButton,
  DescriptionField,
  FailureNote,
  onCommitBoxKey,
  SummaryField,
  useCommitBoxFocus,
  useCommitIds,
  WritingStatus,
} from './parts';
import type { CommitBoxModel } from './useCommitBox';

/**
 * Whether the focus is in the commit box or bar: the one the bar takes over from when it mounts
 * (the view moves the focus across, ChangesView), during the render that mounts it.
 */
function focusInCommitBox(): boolean {
  return document.activeElement?.closest('.commit-box, .commit-bar') != null;
}

interface DescriptionOpen {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The bar's own: where the focus is decides whether the description may open over the list. */
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Whether the bar's description shows. The person opens and closes it; it also opens when Generate
 * starts (its skeleton bars, §4.2) and when a fill writes text into it (Generate's message, Ctrl+Z,
 * a note's "Try again"), so a commit never carries a description the person could not see; the
 * toggle says when it holds text. Over the list in a short window it never hides the focused row or
 * the diff's lines (WCAG 2.4.7): it opens by itself only while the focus is in the bar (with text,
 * when the bar mounts with the focus coming from the commit box), and closes, its text kept, once
 * the focus moves on to another part of the view, or the window turns short with the focus there.
 */
function useDescriptionOpen(model: CommitBoxModel, short: boolean): DescriptionOpen {
  const { description } = model.draft;
  const generating = model.writing === 'generating';
  const [focused, setFocused] = useState(focusInCommitBox);
  const [open, setOpen] = useState(() => description !== '' && (!short || focusInCommitBox()));
  // What the last render saw (React's pattern for information from earlier renders).
  const [seen, setSeen] = useState({ description, generating, short });
  if (seen.description !== description || seen.generating !== generating || seen.short !== short) {
    setSeen({ description, generating, short });
    const filled = (description !== '' && description !== seen.description) || (generating && !seen.generating);
    if (filled && (!short || focused)) setOpen(true);
    else if (short && !seen.short && !focused) setOpen(false);
  }
  return {
    open,
    setOpen,
    onFocus: () => {
      setFocused(true);
    },
    onBlur: (event) => {
      // A window losing the focus has no `relatedTarget`, and changes nothing.
      const to = event.relatedTarget;
      if (!(to instanceof Node) || event.currentTarget.contains(to)) return;
      setFocused(false);
      if (short) setOpen(false);
    },
  };
}

/**
 * The narrow window's commit bar (workspace-history handoff §4.7, decision 30B), pinned under the
 * list: the summary with the message button and the description's toggle, the description when
 * open (over the list's lower half in a short window), the notes between the rows, then the commit
 * button and why committing waits.
 */
export function CommitBar({ model }: { model: CommitBoxModel }) {
  const { t } = useTranslation('changes');
  const short = useShortWindow();
  const { open, setOpen, onFocus, onBlur } = useDescriptionOpen(model, short);
  const descriptionId = useId();
  const ids = useCommitIds();
  const keepFocus = useCommitBoxFocus(model);
  const toggleLabel = open ? t('commit.hideDescription') : model.draft.description === '' ? t('commit.showDescription') : t('commit.showWrittenDescription');
  return (
    <section
      ref={keepFocus}
      className="panel commit-bar"
      aria-label={t('commit.label')}
      onKeyDown={onCommitBoxKey(model)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="commit-bar__row">
        <SummaryField model={model} className="commit-bar__summary" />
        <MessageIconButton model={model} ids={ids} />
        <IconButton
          icon={open ? ChevronDown : ChevronUp}
          label={toggleLabel}
          variant="outline"
          aria-expanded={open}
          aria-controls={descriptionId}
          onPress={() => {
            setOpen(!open);
          }}
        />
      </div>
      <div id={descriptionId} className="commit-bar__description" data-open={open || undefined} data-over={short || undefined}>
        <div className="commit-bar__description-inner">
          <DescriptionField model={model} className="commit-bar__description-field" />
        </div>
      </div>
      {model.failure !== null && <FailureNote failure={model.failure} />}
      {model.writing !== null && (
        <div className="commit-bar__status">
          <WritingStatus model={model} id={ids.status} />
        </div>
      )}
      <AiNoteView model={model} />
      <CommitButton model={model} ids={ids} />
      {model.block !== null && <BlockLine block={model.block} id={ids.reason} />}
    </section>
  );
}
