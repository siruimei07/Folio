import { Info } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../../app/announcer';
import { Banner } from '../../../components/Banner/Banner';
import { Button } from '../../../components/Button/Button';
import { PendingButton } from '../../../components/Button/PendingButton';
import { ToneIcon } from '../../../components/feedback';
import { Field } from '../../../components/Field/Field';
import { aiService, useAiKey } from '../../../data/ai';
import type { AiSettings, IpcError } from '../../../ipc';
import { SIZE } from '../../../tokens/tokens';
import { ipcErrorOf, showFailure } from '../../feedback';
import { Card } from '../../parts/Card';
import { type TestResult, testLine } from './testResult';

/** What the card is doing: saving a typed key, removing the saved one or testing it. */
type Busy = 'save' | 'remove' | 'test' | null;

/** A failure shown as a banner: which action failed and the shell's error. */
interface Failure {
  action: 'save' | 'remove';
  error: IpcError;
}

/**
 * The API key (ipc-m2 §12.2): write-only, so the card never shows any character of a saved key,
 * only that one is saved (Sirui, 2026-10-05). With no key it shows a password field and Save; with
 * one, "A key is saved" with Test, Replace and Remove. The typed key stays in this component's state
 * only until the save answers: it is dropped after a success, a declined Windows confirmation
 * (§12.3) or a failure the user cannot fix in the field, and kept after `AiKeyInvalid` so they
 * can fix it. It never goes into a query, a mutation, an announcement or a toast.
 *
 * Test sends the service a minimal request with the saved key (§12.4) and words the answer in a
 * status line. The result belongs to that key: it clears when a key is saved or removed, here or
 * elsewhere, and AiPage keys the card by endpoint, so a change of service starts it afresh.
 */
export function KeyCard({ settings }: { settings: AiSettings }) {
  const { t } = useTranslation(['settings', 'errors']);
  const key = useAiKey();
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  // A key saved or removed elsewhere makes the last result stale: drop it as `hasKey` changes.
  const [resultHasKey, setResultHasKey] = useState(settings.hasKey);
  if (resultHasKey !== settings.hasKey) {
    setResultHasKey(settings.hasKey);
    setResult(null);
  }
  const input = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the next state has rendered: the field, Test or Replace. A save's
  // or removal's answer reaches the cache, and so `hasKey`, a render after this card's own state,
  // so the target waits until it is on screen.
  const focusNext = useRef<'field' | 'test' | 'replace' | null>(null);

  useEffect(() => {
    const targets = { field: input, test: testButton, replace: replaceButton };
    const target = focusNext.current === null ? null : targets[focusNext.current].current;
    if (target === null) return;
    focusNext.current = null;
    target.focus();
  });

  // The card unmounts while a save or removal can still run: a change of service or a closed
  // dialog. Its answer then has no card to show it: a failure becomes a toast so it is not lost,
  // and a success says nothing, since the page no longer shows this key (the card shows it again).
  // Each action ends `busy` in a `finally`: a throw that is not the shell's error (a bug, which
  // `ipcErrorOf` rethrows to the app's error handler) must not leave the card read-only.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A key removed elsewhere (a change of service) ends a replacement: there is nothing to replace.
  const isReplacing = replacing && settings.hasKey;
  const showField = !settings.hasKey || isReplacing;
  const canSave = draft.trim() !== '' && busy === null;

  /** Drops the typed key and any message about it. */
  const reset = () => {
    setDraft('');
    setFieldError(null);
  };

  const save = async () => {
    if (!canSave) return;
    setBusy('save');
    setFieldError(null);
    setDeclined(false);
    setFailure(null);
    let answer: AiSettings | null;
    try {
      answer = await key.set(draft);
    } catch (thrown: unknown) {
      const error = ipcErrorOf(thrown);
      if (!mounted.current) {
        showFailure(t('ai.key.saveFailed'), error, 'settings.ai');
        return;
      }
      if (error.code === 'AiKeyInvalid') {
        // The one failure the user fixes in the field: the typed key stays.
        setFieldError(t('errors:AiKeyInvalid'));
        focusNext.current = 'field';
        return;
      }
      setDraft('');
      setFailure({ action: 'save', error });
      focusNext.current = 'field';
      return;
    } finally {
      setBusy(null);
    }
    if (!mounted.current) return;
    reset();
    if (answer === null) {
      // The user chose Cancel in Windows' confirmation (§12.3): nothing was stored.
      setDeclined(true);
      announce(t('ai.key.declined'));
      focusNext.current = 'field';
      return;
    }
    setReplacing(false);
    setResult(null);
    // Testing is the next step for a new key.
    focusNext.current = 'test';
    announce(t('ai.key.savedAnnouncement'));
  };

  const remove = async () => {
    if (busy !== null) return;
    setBusy('remove');
    setDeclined(false);
    setFailure(null);
    try {
      await key.clear();
    } catch (thrown: unknown) {
      const error = ipcErrorOf(thrown);
      if (!mounted.current) {
        showFailure(t('ai.key.removeFailed'), error, 'settings.ai');
        return;
      }
      setFailure({ action: 'remove', error });
      return;
    } finally {
      setBusy(null);
    }
    if (!mounted.current) return;
    reset();
    setReplacing(false);
    setResult(null);
    focusNext.current = 'field';
    announce(t('ai.key.removed'));
  };

  const test = async () => {
    if (busy !== null) return;
    setBusy('test');
    setFailure(null);
    // Emptied first, so the same result twice is announced twice.
    setResult(null);
    let next: TestResult;
    try {
      await key.test();
      next = { ok: true };
    } catch (thrown: unknown) {
      next = { ok: false, error: ipcErrorOf(thrown) };
    } finally {
      setBusy(null);
    }
    setResult(next);
  };

  const startReplacing = () => {
    reset();
    setDeclined(false);
    setFailure(null);
    setResult(null);
    setReplacing(true);
    focusNext.current = 'field';
  };

  const cancelReplacing = () => {
    if (busy !== null) return;
    reset();
    setDeclined(false);
    setReplacing(false);
    focusNext.current = 'replace';
  };

  // Esc in the replacement field goes back to the saved key instead of closing the dialog.
  const onFieldKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !isReplacing) return;
    event.preventDefault();
    event.stopPropagation();
    cancelReplacing();
  };

  const line = result === null ? null : testLine(t, aiService(settings), result);

  return (
    <Card title={t(`ai.key.title.${aiService(settings)}`)}>
      {showField ? (
        <div className="settings-key" onKeyDown={onFieldKeyDown}>
          <Field
            label={isReplacing ? t('ai.key.newLabel') : t('ai.key.label')}
            type="password"
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setFieldError(null);
              setDeclined(false);
            }}
            error={fieldError}
            help={t('ai.key.help')}
            readOnly={busy === 'save'}
            inputRef={input}
            onEnter={() => {
              void save();
            }}
            trailing={
              <>
                <PendingButton
                  variant="accent"
                  pending={busy === 'save' ? t('saving') : null}
                  isDisabled={draft.trim() === ''}
                  onPress={() => {
                    void save();
                  }}
                >
                  {t('save')}
                </PendingButton>
                {isReplacing ? (
                  <Button size="dialog" isDisabled={busy !== null} onPress={cancelReplacing}>
                    {t('cancel')}
                  </Button>
                ) : (
                  // There is no key to test yet.
                  <Button size="dialog" isDisabled>
                    {t('ai.test.action')}
                  </Button>
                )}
              </>
            }
          />
        </div>
      ) : (
        <div className="settings-key">
          <div className="settings-card__footer">
            <p className="settings-card__status">
              <ToneIcon tone="success" size="small" />
              <span>{t('ai.key.saved')}</span>
            </p>
            <PendingButton
              ref={testButton}
              pending={busy === 'test' ? t('ai.test.testing') : null}
              // Pending, not disabled: the button keeps focus while the service answers.
              isPending={busy === 'test'}
              isDisabled={busy === 'remove'}
              onPress={() => {
                void test();
              }}
            >
              {t('ai.test.action')}
            </PendingButton>
            <Button ref={replaceButton} size="dialog" isDisabled={busy !== null} onPress={startReplacing}>
              {t('ai.key.replace')}
            </Button>
            <PendingButton
              pending={busy === 'remove' ? t('ai.key.removing') : null}
              // Pending, not disabled: the button keeps focus while the key is removed.
              isPending={busy === 'remove'}
              isDisabled={busy === 'test'}
              onPress={() => {
                void remove();
              }}
            >
              {t('ai.key.remove')}
            </PendingButton>
          </div>
          <p className="field__help">{t('ai.key.help')}</p>
        </div>
      )}
      {/* Present with the saved key before any test, so each result is announced. */}
      {!showField && (
        <p className="settings-card__status" role="status">
          {line !== null && (
            <>
              <ToneIcon tone={line.tone} size="small" />
              <span>{line.text}</span>
            </>
          )}
        </p>
      )}
      {declined && (
        <p className="settings-note">
          <Info aria-hidden size={SIZE.icon} className="settings-note__icon" />
          {t('ai.key.declined')}
        </p>
      )}
      {failure !== null && (
        <Banner
          tone="danger"
          size="block"
          announce
          title={failure.action === 'save' ? t('ai.key.saveFailed') : t('ai.key.removeFailed')}
          text={t(`errors:${failure.error.code}`)}
        />
      )}
    </Card>
  );
}
