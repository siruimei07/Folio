import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { FieldError } from '../../components/FieldError/FieldError';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { useIgnoreRules, useSetIgnoreRules } from '../../data/settings';
import { DEFAULT_IGNORE_RULES, type IpcError, LIMITS } from '../../ipc';
import { charCount } from '../../lib/text';
import { ipcErrorOf, LoadFailure, useRetryFailed } from '../feedback';
import { Card, Page } from '../parts/Card';

/** The rules as the shell stores them: LF line breaks, the trailing ones dropped (ipc-m1 §22.2). */
function stored(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}

/**
 * Library settings → Ignore rules (app-shell handoff §9; ipc-m1 §22.2): the library's patterns in
 * gitignore syntax, saved with Save. Lines the scans skip are named under the field, a file that
 * cannot be used at all gets a banner, and Folio's own defaults are one click away. A save starts
 * a scan, which the activity button shows.
 */
export function IgnoreRulesPage() {
  const { t } = useTranslation(['settings', 'errors']);
  const id = useId();
  const rules = useIgnoreRules();
  const save = useSetIgnoreRules();
  const retry = useRetryFailed();
  // What the user typed; `null` until they type, so the stored rules show as they arrive.
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<IpcError | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  if (rules.error !== null) {
    return (
      <Page>
        <LoadFailure title={t('ignore.loadFailed')} error={rules.error.error} retry={retry} />
      </Page>
    );
  }
  if (rules.data === undefined) {
    return (
      <Page>
        <Skeleton rows={6} />
      </Page>
    );
  }

  const text = draft ?? rules.data.text;
  const changed = draft !== null && stored(draft) !== stored(rules.data.text);
  const over = charCount(stored(text)) - LIMITS.ignoreRulesChars;
  // The shell's marks are for the saved text; while the field differs they may name other lines.
  const invalid = changed ? [] : rules.data.invalidLines.filter((line) => line > 0);
  const broken = !changed && rules.data.invalidLines.includes(0);

  const errorId = `${id}-error`;
  const linesId = `${id}-lines`;
  const helpId = `${id}-help`;
  const fieldError = over > 0 ? t('ignore.tooLong', { limit: LIMITS.ignoreRulesChars, over }) : null;

  const onSave = async () => {
    if (save.isPending || fieldError !== null) return;
    setFailure(null);
    setSaved(false);
    try {
      await save.mutateAsync({ text });
    } catch (error: unknown) {
      setFailure(ipcErrorOf(error));
      return;
    }
    setDraft(null);
    setSaved(true);
    // Save turns off once the rules are saved; focus stays in the page.
    field.current?.focus();
  };

  return (
    <Page>
      {broken && <Banner tone="danger" size="block" title={t('ignore.broken.title')} text={t('ignore.broken.text')} />}
      <Card title={t('ignore.title')} description={t('ignore.description')}>
        <div className="settings-rules">
          <label className="field__label" htmlFor={`${id}-input`}>
            {t('ignore.label')}
          </label>
          <textarea
            ref={field}
            id={`${id}-input`}
            className="text-input settings-rules__input"
            value={text}
            spellCheck={false}
            autoComplete="off"
            readOnly={save.isPending}
            aria-invalid={fieldError !== null || undefined}
            aria-describedby={[fieldError !== null ? errorId : null, invalid.length > 0 ? linesId : null, helpId]
              .filter(Boolean)
              .join(' ')}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
          {fieldError !== null && <FieldError id={errorId}>{fieldError}</FieldError>}
          {invalid.length > 0 && (
            <p id={linesId} className="settings-rules__lines" data-tone="warning">
              {invalid.length === 1
                ? t('ignore.invalidLine', { line: invalid[0] })
                : t('ignore.invalidLines', { lines: invalid.join(', ') })}
            </p>
          )}
          <p id={helpId} className="field__help">
            {t('ignore.help')}
          </p>
        </div>
        {failure !== null && (
          <Banner tone="danger" size="block" announce title={t('ignore.saveFailed')} text={t(`errors:${failure.code}`)} />
        )}
        <div className="settings-card__footer">
          <p className="settings-card__status" role="status">
            {saved ? t('ignore.saved') : changed ? t('ignore.unsaved') : null}
          </p>
          {changed && (
            <Button
              size="dialog"
              isDisabled={save.isPending}
              onPress={() => {
                setDraft(null);
              }}
            >
              {t('ignore.revert')}
            </Button>
          )}
          <PendingButton
            variant="accent"
            pending={save.isPending ? t('saving') : null}
            isDisabled={!changed || fieldError !== null}
            onPress={() => {
              void onSave();
            }}
          >
            {t('save')}
          </PendingButton>
        </div>
      </Card>
      <details className="settings-defaults">
        <summary className="settings-defaults__summary">{t('ignore.defaults.summary')}</summary>
        <p className="field__help">{t('ignore.defaults.text')}</p>
        <pre className="settings-defaults__rules" aria-label={t('ignore.defaults.label')}>
          {DEFAULT_IGNORE_RULES}
        </pre>
      </details>
    </Page>
  );
}
