import '../components/tone.css';

import { CircleAlert, CircleX, Folder, FolderX, Lock, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton } from 'react-aria-components';

import { announce } from '../app/announcer';
import { DETAILED } from '../app/feedback';
import { reportUiError } from '../app/log';
import { closeDialog } from '../app/navigation';
import { copyDetails, copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { IpcFailure } from '../data/errors';
import { useDiscardUnfinishedMove, useLibraryStatus } from '../data/library';
import type { IpcError, LibraryStatus, Unavailable as Reason } from '../ipc';
import { SIZE } from '../tokens/tokens';
import { useOpenChosen, usePickFolder } from './choose';
import { DiscardMoveDialog, useDiscardFailure } from './DiscardMove';
import { useStepFailure } from './failures';
import { Frame } from './Frame';
import { showFolder } from '../app/startFlow';
import { PendingButton } from '../components/Button/PendingButton';

interface StatePageProps {
  tone: 'warning' | 'danger';
  icon: LucideIcon;
  title: string;
  text: string;
  /** The library folder, in a read-only field. */
  path?: string;
  /** A banner under the path field: a failure of "Locate library…", "Try again" or "Discard move…". */
  banner?: ReactNode;
  /** The buttons; the first is the accent one. */
  actions: ReactNode;
  link?: ReactNode;
}

/**
 * A full-window state (first-run handoff §7): a centred column with the state tile, the title
 * (which takes focus, so it is read), the text, the library path, the buttons and a link row.
 */
function StatePage({ tone, icon: Icon, title, text, path, banner, actions, link }: StatePageProps) {
  const { t } = useTranslation('first-run');
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <Frame windowTitle={t('documentTitle.page', { page: title })} layout="state" focus={heading}>
      <div className="state-page">
        <span className="state-page__tile" data-tone={tone} aria-hidden>
          <Icon size={SIZE.iconLarge} />
        </span>
        <h1 ref={heading} className="state-page__title" tabIndex={-1}>
          {title}
        </h1>
        <p className="state-page__text">{text}</p>
        {path !== undefined && (
          <div className="state-page__path">
            <Folder aria-hidden size={SIZE.icon} className="state-page__path-icon" />
            <input
              className="state-page__path-input"
              aria-label={t('unavailable.pathLabel')}
              value={path}
              readOnly
              spellCheck={false}
            />
          </div>
        )}
        {banner}
        <div className="state-page__actions">{actions}</div>
        {link}
      </div>
    </Frame>
  );
}

type Action = 'locate' | 'retry' | 'copy' | 'discard';

/** Each reason's tile and buttons, the accent one first (§7), and whether it offers a new library. */
const REASONS: Record<Reason, { tone: 'warning' | 'danger'; icon: LucideIcon; actions: Action[]; startNew: boolean }> = {
  missing: { tone: 'warning', icon: FolderX, actions: ['locate', 'retry'], startNew: true },
  notALibrary: { tone: 'warning', icon: FolderX, actions: ['retry', 'locate'], startNew: true },
  newerFormat: { tone: 'warning', icon: CircleAlert, actions: ['retry'], startNew: true },
  accessDenied: { tone: 'danger', icon: Lock, actions: ['retry', 'locate'], startNew: false },
  catalogFailed: { tone: 'danger', icon: CircleX, actions: ['retry', 'copy'], startNew: false },
  unfinishedMove: { tone: 'warning', icon: CircleAlert, actions: ['discard', 'retry'], startNew: false },
};

/** A failed action, and which: "Discard move…" words its failures its own way. */
interface Failure {
  error: IpcError;
  of: 'open' | 'discard';
}

/**
 * The library cannot be opened (first-run handoff §7), at start-up or while Folio runs: why, the
 * folder, and what to do. "Try again" asks for the status, which opens the library again when it
 * can (ipc-m1 §6); "Locate library…" opens the folder where it is now; "Discard move…" asks, then
 * lets go of an unfinished move and opens the library again. The gate keys this page by reason,
 * so a new reason starts it afresh: its title takes focus, and a dialog of the old one closes.
 */
export function Unavailable({ root, reason }: { root: string; reason: Reason }) {
  const { t } = useTranslation(['first-run', 'shell']);
  const status = useLibraryStatus();
  const { pick, picking } = usePickFolder();
  const { open, opening } = useOpenChosen();
  const discard = useDiscardUnfinishedMove();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const spec = REASONS[reason];
  const title = t(`unavailable.${reason}.title`);
  const busy = picking || opening || retrying || discard.isPending;

  // Open dialogs close without saving, and the title is read (§7).
  useEffect(() => {
    closeDialog();
    announce(title);
  }, [title]);

  const retry = async () => {
    if (busy) return;
    setFailure(null);
    setRetrying(true);
    const result = await status.refetch();
    setRetrying(false);
    if (result.error !== null) setFailure({ error: result.error.error, of: 'open' });
    else if (result.data !== undefined) announceSame(result.data);
  };

  // Still unavailable for the same reason: nothing changes on screen, so the title is read again.
  // A new reason reads its own title as the page changes.
  const announceSame = (answer: LibraryStatus) => {
    if (answer.state === 'unavailable' && answer.reason === reason) announce(title);
  };

  // The dialog stays open while the command runs and closes on its answer: the page follows a
  // status that changed, and a failure shows under the folder, focus back on "Discard move…".
  // Codes that point at a bug go to the log, as a failed command's toast sends them (§9.4).
  const confirmDiscard = async () => {
    if (discard.isPending) return;
    setFailure(null);
    try {
      announceSame(await discard.mutateAsync());
    } catch (error: unknown) {
      if (!(error instanceof IpcFailure)) throw error;
      if (DETAILED.has(error.error.code)) reportUiError('command', 'firstRun.discardMove', error.error);
      setFailure({ error: error.error, of: 'discard' });
    } finally {
      setConfirming(false);
    }
  };

  const locate = async () => {
    if (busy) return;
    const choice = await pick();
    if (choice === null) return;
    setFailure(null);
    if (choice.content.kind !== 'library') {
      const code = choice.content.kind === 'insideLibrary' ? 'AlreadyALibrary' : 'NotALibrary';
      setFailure({ error: { code, detail: choice.path }, of: 'open' });
      return;
    }
    const failed = await open(choice);
    if (failed !== null) setFailure({ error: failed, of: 'open' });
  };

  const startNew = async () => {
    if (busy) return;
    const choice = await pick();
    // Step 1's Back returns here: the status is still unavailable.
    if (choice !== null) showFolder(choice, 'new');
  };

  const buttons: Record<Action, { label: string; pending: string | null; onPress: () => void }> = {
    locate: {
      label: t('unavailable.locate'),
      pending: opening ? t('folder.opening') : null,
      onPress: () => {
        void locate();
      },
    },
    retry: {
      label: t('unavailable.tryAgain'),
      pending: retrying ? t('unavailable.trying') : null,
      onPress: () => {
        void retry();
      },
    },
    copy: {
      label: t('shell:copyDetails.action'),
      pending: null,
      onPress: () => {
        copyDetails([title, `${reason}: ${root}`].join('\n'));
      },
    },
    discard: {
      label: t('unavailable.discard.action'),
      pending: null,
      onPress: () => {
        if (!busy) setConfirming(true);
      },
    },
  };

  return (
    <>
      <StatePage
        tone={spec.tone}
        icon={spec.icon}
        title={title}
        text={t(`unavailable.${reason}.text`)}
        path={root}
        banner={failure === null ? undefined : <FailureBanner failure={failure} root={root} />}
        actions={spec.actions.map((action, index) => (
          <PendingButton
            key={action}
            variant={index === 0 ? 'accent' : 'outline'}
            pending={buttons[action].pending}
            onPress={buttons[action].onPress}
          >
            {buttons[action].label}
          </PendingButton>
        ))}
        link={
          spec.startNew ? (
            <p className="state-page__link">
              {t('unavailable.or')}{' '}
              <AriaButton
                className="link-button"
                onPress={() => {
                  void startNew();
                }}
              >
                {t('unavailable.startNew')}
              </AriaButton>
            </p>
          ) : undefined
        }
      />
      {/* Only "Discard move…" opens it; the gate keys this page by reason. */}
      <DiscardMoveDialog
        isOpen={confirming}
        discarding={discard.isPending}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          void confirmDiscard();
        }}
      />
    </>
  );
}

/**
 * A failure under the folder: of "Locate library…" or "Try again", worded as step 1 words it
 * (§4.4), or of "Discard move…" (§7).
 */
function FailureBanner({ failure, root }: { failure: Failure; root: string }) {
  const { t } = useTranslation('shell');
  const stepFailure = useStepFailure();
  const discardFailure = useDiscardFailure();
  const { error } = failure;
  const step = failure.of === 'open' ? stepFailure(error, null) : null;
  const { tone, title, text, details } =
    step === null ? discardFailure(error, root) : { ...step, details: step.footer.end.includes('copyDetails') };
  return (
    <Banner
      size="block"
      tone={tone}
      announce
      title={title}
      text={text}
      actions={
        details ? (
          <Button
            size="compact"
            onPress={() => {
              copyErrorDetails(title, error);
            }}
          >
            {t('copyDetails.action')}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * No library state at all (§7): the data directory is unusable, or the window cannot reach the
 * shell (any other failure says what its code says). One button, "Copy details".
 */
export function CantStart({ error }: { error: IpcError }) {
  const { t } = useTranslation(['first-run', 'errors', 'shell']);
  const title = t('cantStart.title');
  const text =
    error.code === 'DataDirUnavailable'
      ? t('cantStart.dataDir')
      : error.code === 'Transport'
        ? t('cantStart.transport')
        : t(`errors:${error.code}`);
  return (
    <StatePage
      tone="danger"
      icon={CircleX}
      title={title}
      text={text}
      actions={
        <Button
          size="dialog"
          variant="accent"
          onPress={() => {
            copyErrorDetails(title, error);
          }}
        >
          {t('shell:copyDetails.action')}
        </Button>
      }
    />
  );
}
