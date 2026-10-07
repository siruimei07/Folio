import '../components/messageFields.css';
import './EditMessageDialog.css';

import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../app/announcer';
import { showChange } from '../app/changeTarget';
import { focusCommit, focusCommitWhenShown } from '../app/CommitActions';
import { DETAILED, showGone, whenSettled } from '../app/feedback';
import { reportUiError } from '../app/log';
import { useNavigation, type ViewId } from '../app/navigation';
import type { DialogComponentProps } from '../app/registry';
import { showToast } from '../app/toasts';
import { focusViewButton } from '../app/viewFocus';
import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { PendingButton } from '../components/Button/PendingButton';
import { DialogFrame } from '../components/Dialog/Dialog';
import { FieldError } from '../components/FieldError/FieldError';
import { useRewordCommit } from '../data/history';
import { type CommitInfo, type IpcError, LIMITS, shortId } from '../ipc';
import { formatDateTime, formatTime, isSameDay } from '../lib/format';
import {
  checkMessage,
  isMessageProblem,
  isSummaryProblem,
  type Message,
  type MessageProblem,
  normalizeMessage,
  sameMessage,
} from './model/message';
import { Refocus } from './Refocus';
import { focusTimeline } from './state';

/** The codes the failure block names its own reason for (§9.1); any other says `errors.<code>`. */
const REASONS = ['CannotReword', 'HistoryReadOnly'] as const;

function isReason(code: string): code is (typeof REASONS)[number] {
  return (REASONS as readonly string[]).includes(code);
}

/** "Copy details" for the codes that point at a bug, and a damaged history (§7.5), as Restore. */
function offersDetails(code: string): boolean {
  return DETAILED.has(code) || code === 'HistoryDamaged';
}

/** Whether nothing has the focus: the page has it, as when the element it would go back to went. */
function isFocusOnPage(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** The views that show commits (History's entries, the Not synced card), which `focusCommit` finds. */
function listsCommits(view: ViewId): boolean {
  return view === 'history' || view === 'changes';
}

/**
 * The view showing takes the focus, as when another view's link shows it: History's timeline (or
 * the diff over it in a narrow window), the Changes list, else the rail's button of the view.
 */
function focusShownView(): void {
  const { view } = useNavigation.getState();
  if (view === 'history') focusTimeline();
  else if (view === 'changes') showChange();
  else focusViewButton();
}

/** The message the commit has: what the fields start with, and what "unchanged" compares with. */
function storedMessage(commit: CommitInfo): Message {
  return { summary: commit.summary ?? '', body: commit.body };
}

interface Draft {
  summary: string;
  description: string;
}

function draftOf(commit: CommitInfo): Draft {
  return { summary: commit.summary ?? '', description: commit.body ?? '' };
}

/**
 * "Edit message" (handoff workspace-history §9.1; ipc-m2 §8.4), opened on a commit from History's
 * entries, the Not synced card and the fallback toast: the summary (selected, with the focus) and
 * the description as the commit box's field group draws them, then "b7c1e20 · Today 5:05 PM · 3
 * files. You can edit a message until the commit is synced." "Save message" stays pending (focusable,
 * `aria-disabled`) while the message is the stored one; Ctrl+Enter saves too. A message that breaks
 * a rule says so under its field before anything is sent, and when the shell says so. Saving:
 * "Saving…" with the fields read-only and Cancel and Esc waiting; done: the dialog closes with
 * "Saved the new message" / "a1b2c3d is now “…”." (the new short id); failed: the danger block, the
 * dialog stays. A commit gone meanwhile closes it with the shell's words (the history is refreshed).
 */
export function EditMessageDialog(props: DialogComponentProps<'editMessage'>) {
  // Each opening starts afresh: the store hands a new `params` each time, and the dialog stays
  // mounted between openings to fade out.
  return <EditMessageFrame key={openingOf(props.params)} {...props} />;
}

const openings = new WeakMap<object, number>();
let lastOpening = 0;

/** A number for each opening: its `params`, which the navigation store makes anew each time. */
function openingOf(params: object): number {
  let opening = openings.get(params);
  if (opening === undefined) {
    lastOpening += 1;
    opening = lastOpening;
    openings.set(params, opening);
  }
  return opening;
}

function EditMessageFrame({ isOpen, params, onClose }: DialogComponentProps<'editMessage'>) {
  const { t, i18n } = useTranslation(['history', 'errors', 'shell']);
  const ids = useId();
  const { commit } = params;
  const reword = useRewordCommit();
  const [draft, setDraft] = useState(() => draftOf(commit));
  const [problem, setProblem] = useState<MessageProblem | null>(null);
  const [failure, setFailure] = useState<IpcError | null>(null);
  const [saving, setSaving] = useState(false);
  // Today as of when it opened, for "Today 5:05 PM".
  const [now] = useState(() => Date.now());
  // The commit's new id once saved: its entry or row, which replaced the one the dialog came from,
  // takes the focus when React Aria finds nothing to give it back to. Closed without saving, the
  // commit's own entry or row takes it when React Aria left it on the page: the menu item it was
  // opened from has gone, or the opener could not take the focus (WCAG 2.4.3). When neither can (a
  // commit gone meanwhile, undone or replaced by another edit; one the view leaves out or hides; a
  // view that lists no commits, as the Library, where the fallback toast opened it), the view
  // showing takes it (`focusShownView`).
  const saved = useRef<string | null>(null);
  const refocus = useCallback(() => {
    const listed = listsCommits(useNavigation.getState().view);
    if (saved.current !== null) {
      if (listed) focusCommitWhenShown(saved.current, focusShownView);
      else if (isFocusOnPage()) focusShownView();
      return;
    }
    if (!isFocusOnPage() || (listed && focusCommit(commit.id))) return;
    focusShownView();
  }, [commit.id]);
  const summaryRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // The summary takes the focus with its text selected (§9.1), after React Aria has moved the focus
  // into the dialog.
  useEffect(() => {
    if (!isOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      summaryRef.current?.focus();
      summaryRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  const message = normalizeMessage(draft.summary, draft.description);
  const unchanged = sameMessage(message, storedMessage(commit));

  const problemText = (shown: MessageProblem): string =>
    isSummaryProblem(shown)
      ? t(`editMessage.problems.${shown}`, { limit: LIMITS.summaryChars })
      : t(`editMessage.problems.${shown}`, { limit: LIMITS.bodyChars });

  // The field takes the focus, which reads its error out with its description; a field that has it
  // already (Ctrl+Enter typed in it) gets no focus event, so its error is announced instead (WCAG
  // 4.1.3).
  const showProblem = (next: MessageProblem) => {
    setProblem(next);
    const field = isSummaryProblem(next) ? summaryRef.current : descriptionRef.current;
    if (field !== null && field === document.activeElement) announce(problemText(next));
    else field?.focus();
  };

  const save = () => {
    if (saving || unchanged) return;
    const broken = checkMessage(message);
    if (broken !== null) {
      showProblem(broken);
      return;
    }
    setSaving(true);
    setFailure(null);
    whenSettled(
      reword.mutateAsync({ commit: commit.id, summary: message.summary.toWellFormed(), body: message.body?.toWellFormed() ?? null }),
      'history.reword',
      (id) => {
        setSaving(false);
        saved.current = id;
        showToast({
          tone: 'success',
          title: t('editMessage.done.title'),
          body: t('editMessage.done.body', { id: shortId(id), summary: message.summary }),
        });
        onClose();
      },
      ({ error }) => {
        setSaving(false);
        if (isMessageProblem(error.code)) {
          showProblem(error.code);
          return;
        }
        if (error.code === 'NotFound') {
          // The commit changed since (another edit): the history has been refreshed.
          showGone(error);
          onClose();
          return;
        }
        if (DETAILED.has(error.code)) reportUiError('command', 'history.reword', error);
        setFailure(error);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    save();
  };

  const ms = Number(commit.timeMs);
  const when = isSameDay(ms, now)
    ? t('editMessage.today', { time: formatTime(ms, i18n.language) })
    : formatDateTime(ms, i18n.language, now);
  const details =
    commit.files > 0
      ? t('editMessage.details', { id: shortId(commit.id), when, count: commit.files })
      : t('editMessage.detailsNoFiles', { id: shortId(commit.id), when });

  const summaryProblem = problem !== null && isSummaryProblem(problem) ? problem : null;
  const bodyProblem = problem !== null && !isSummaryProblem(problem) ? problem : null;
  const failedTitle = t('editMessage.failed');

  return (
    <DialogFrame
      isOpen={isOpen}
      size="medium"
      className="edit-message"
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={t('editMessage.title')}
      banner={
        failure === null ? undefined : (
          <Banner
            tone="danger"
            size="block"
            announce
            title={failedTitle}
            text={isReason(failure.code) ? t(`editMessage.reasons.${failure.code}`) : t(`errors:${failure.code}`)}
            actions={
              offersDetails(failure.code) ? (
                <Button
                  size="compact"
                  onPress={() => {
                    copyErrorDetails(failedTitle, failure);
                  }}
                >
                  {t('shell:copyDetails.action')}
                </Button>
              ) : undefined
            }
          />
        )
      }
      footer={
        <>
          <Button size="dialog" isDisabled={saving} onPress={onClose}>
            {t('editMessage.cancel')}
          </Button>
          <PendingButton
            variant="accent"
            pending={saving ? t('editMessage.saving') : null}
            isPending={unchanged}
            onPress={save}
          >
            {t('editMessage.save')}
          </PendingButton>
        </>
      }
    >
      <div className="edit-message__body" onKeyDown={onKeyDown}>
        <div className="edit-message__group message-group" data-invalid={problem !== null || undefined}>
          <input
            ref={summaryRef}
            type="text"
            className="edit-message__summary message-field message-field--summary message-group__summary"
            aria-label={t('editMessage.summary')}
            aria-invalid={summaryProblem !== null || undefined}
            aria-describedby={summaryProblem === null ? `${ids}-details` : `${ids}-summary-error ${ids}-details`}
            placeholder={t('editMessage.summaryPlaceholder')}
            value={draft.summary}
            readOnly={saving}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setDraft({ ...draft, summary: event.target.value });
              if (summaryProblem !== null) setProblem(null);
            }}
          />
          <textarea
            ref={descriptionRef}
            className="edit-message__description message-field message-field--description"
            aria-label={t('editMessage.description')}
            aria-invalid={bodyProblem !== null || undefined}
            aria-describedby={bodyProblem === null ? undefined : `${ids}-body-error`}
            placeholder={t('editMessage.descriptionPlaceholder')}
            rows={4}
            value={draft.description}
            readOnly={saving}
            spellCheck={false}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
              if (bodyProblem !== null) setProblem(null);
            }}
          />
        </div>
        {summaryProblem !== null && <FieldError id={`${ids}-summary-error`}>{problemText(summaryProblem)}</FieldError>}
        {bodyProblem !== null && <FieldError id={`${ids}-body-error`}>{problemText(bodyProblem)}</FieldError>}
        <p id={`${ids}-details`} className="edit-message__details">
          {details}
        </p>
      </div>
      <Refocus refocus={refocus} />
    </DialogFrame>
  );
}
