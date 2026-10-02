import '../components/tone.css';

import { CircleAlert, CircleX, Folder, FolderX, Lock, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton } from 'react-aria-components';

import { announce } from '../app/announcer';
import { closeDialog } from '../app/navigation';
import { copyDetails, copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { useLibraryStatus } from '../data/library';
import type { IpcError, Unavailable as Reason } from '../ipc';
import { SIZE } from '../tokens/tokens';
import { useOpenChosen, usePickFolder } from './choose';
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
  /** A banner under the path field: a failure of "Locate library…" or "Try again". */
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

type Action = 'locate' | 'retry' | 'copy';

/** Each reason's tile and buttons, the accent one first (§7), and whether it offers a new library. */
const REASONS: Record<Reason, { tone: 'warning' | 'danger'; icon: LucideIcon; actions: Action[]; startNew: boolean }> = {
  missing: { tone: 'warning', icon: FolderX, actions: ['locate', 'retry'], startNew: true },
  notALibrary: { tone: 'warning', icon: FolderX, actions: ['retry', 'locate'], startNew: true },
  newerFormat: { tone: 'warning', icon: CircleAlert, actions: ['retry'], startNew: true },
  accessDenied: { tone: 'danger', icon: Lock, actions: ['retry', 'locate'], startNew: false },
  catalogFailed: { tone: 'danger', icon: CircleX, actions: ['retry', 'copy'], startNew: false },
};

/**
 * The library cannot be opened (first-run handoff §7), at start-up or while Folio runs: why, the
 * folder, and what to do. "Try again" asks for the status, which opens the library again when it
 * can (ipc-m1 §6); "Locate library…" opens the folder where it is now.
 */
export function Unavailable({ root, reason }: { root: string; reason: Reason }) {
  const { t } = useTranslation(['first-run', 'shell']);
  const status = useLibraryStatus();
  const { pick, picking } = usePickFolder();
  const { open, opening } = useOpenChosen();
  const [failure, setFailure] = useState<IpcError | null>(null);
  const [retrying, setRetrying] = useState(false);
  const spec = REASONS[reason];
  const title = t(`unavailable.${reason}.title`);
  const busy = picking || opening || retrying;

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
    if (result.error !== null) setFailure(result.error.error);
    // Still unavailable for the same reason: nothing changes on screen, so the title is read again.
    // A new reason reads its own title as the page changes.
    else if (result.data?.state === 'unavailable' && result.data.reason === reason) announce(title);
  };

  const locate = async () => {
    if (busy) return;
    const choice = await pick();
    if (choice === null) return;
    setFailure(null);
    if (choice.content.kind !== 'library') {
      setFailure({ code: choice.content.kind === 'insideLibrary' ? 'AlreadyALibrary' : 'NotALibrary', detail: choice.path });
      return;
    }
    const failed = await open(choice);
    if (failed !== null) setFailure(failed);
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
  };

  return (
    <StatePage
      tone={spec.tone}
      icon={spec.icon}
      title={title}
      text={t(`unavailable.${reason}.text`)}
      path={root}
      banner={failure === null ? undefined : <LocateFailure error={failure} />}
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
  );
}

/** A failure of "Locate library…" or "Try again", worded as step 1 words it (§4.4, §7). */
function LocateFailure({ error }: { error: IpcError }) {
  const { t } = useTranslation('shell');
  const { tone, title, text, footer } = useStepFailure()(error, null);
  return (
    <Banner
      size="block"
      tone={tone}
      announce
      title={title}
      text={text}
      actions={
        footer.end.includes('copyDetails') ? (
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
