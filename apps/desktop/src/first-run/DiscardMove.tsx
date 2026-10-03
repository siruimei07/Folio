// "Discard move" on the unavailable screen for an unfinished move (first-run handoff §7, ipc-m1
// §6): the alert dialog that asks first, and the wording of a discard that failed.
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button/Button';
import { PendingButton } from '../components/Button/PendingButton';
import { DialogFrame } from '../components/Dialog/Dialog';
import type { Tone } from '../components/feedback';
import { driveOf } from '../data/names';
import type { IpcError } from '../ipc';

interface DiscardMoveDialogProps {
  isOpen: boolean;
  /** The command runs: the confirm button spins, and Cancel and Esc wait for the answer. */
  discarding: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Asks before Folio lets go of the move (§7): what goes (Folio's record of the move) and what
 * stays (the files, where they are now). An alert dialog, read with its description; Cancel has
 * the focus, and focus returns to "Discard move…" when it closes.
 */
export function DiscardMoveDialog({ isOpen, discarding, onCancel, onConfirm }: DiscardMoveDialogProps) {
  const { t } = useTranslation('first-run');
  return (
    <DialogFrame
      isOpen={isOpen}
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !discarding) onCancel();
      }}
      title={t('unavailable.discard.title')}
      description={t('unavailable.discard.text')}
      footer={
        <>
          <Button size="dialog" autoFocus isDisabled={discarding} onPress={onCancel}>
            {t('unavailable.discard.cancel')}
          </Button>
          <PendingButton
            variant="danger"
            pending={discarding ? t('unavailable.discard.discarding') : null}
            onPress={onConfirm}
          >
            {t('unavailable.discard.confirm')}
          </PendingButton>
        </>
      }
    >
      <p className="discard-move__check">{t('unavailable.discard.check')}</p>
    </DialogFrame>
  );
}

/**
 * The codes the user can do something about, each with its own words (a full disk names its
 * drive). Any other code reads `other` and offers "Copy details"; `Transport` reads the generic
 * words of its code (`errors`) and offers them too (§7).
 */
const ACTIONABLE = ['InUse', 'AccessDenied', 'DiskFull', 'NewerFormat', 'Busy'] as const;
type Actionable = (typeof ACTIONABLE)[number];

function isActionable(code: string): code is Actionable {
  return (ACTIONABLE as readonly string[]).includes(code);
}

export interface DiscardFailure {
  tone: Tone;
  title: string;
  text: string;
  /** Offer "Copy details": the failure points at a bug or a broken state. */
  details: boolean;
}

/**
 * Words a failed discard for the screen's banner: what to do for each code, and whether to offer
 * "Copy details". `root` is the library folder, whose drive a full disk names.
 */
export function useDiscardFailure(): (error: IpcError, root: string) => DiscardFailure {
  const { t } = useTranslation(['first-run', 'errors']);
  const textOf = (code: string, root: string): string => {
    if (code === 'Transport') return t('errors:Transport');
    if (!isActionable(code)) return t('unavailable.discard.errors.other');
    if (code !== 'DiskFull') return t(`unavailable.discard.errors.${code}`);
    const drive = driveOf(root);
    return drive === null
      ? t('unavailable.discard.errors.DiskFullNoDrive')
      : t('unavailable.discard.errors.DiskFull', { drive });
  };
  return ({ code }, root) => ({
    tone: 'danger',
    title: t('unavailable.discard.failed'),
    text: textOf(code, root),
    details: !isActionable(code),
  });
}
