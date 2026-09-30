import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Panel } from '../components/Panel/Panel';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { type AppInfo, type IpcError, ipc } from '../ipc';

type State = { kind: 'loading' } | { kind: 'ready'; info: AppInfo } | { kind: 'failed'; error: IpcError };

/**
 * Stands in for the Library view until `feat/ui-library-view` registers its own: the Library panel
 * and the preview beside it, with the app's versions, which prove the path UI → IPC → Rust.
 */
export function PlaceholderLibrary() {
  const { t } = useTranslation(['shell', 'common', 'errors']);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void ipc.appInfo().then((result) => {
      if (!active) return;
      setState(
        result.status === 'ok' ? { kind: 'ready', info: result.data } : { kind: 'failed', error: result.error },
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="placeholder-view">
      <Panel title={t('placeholder.title')} className="placeholder-view__library">
        <div className="placeholder-view__body">
          <p className="placeholder-view__text">{t('placeholder.text')}</p>
          {state.kind === 'loading' && <Skeleton rows={3} />}
          {state.kind === 'failed' && <p role="alert">{t(`errors:${state.error.code}`)}</p>}
          {state.kind === 'ready' && (
            <dl className="placeholder-view__info">
              <dt>{t('appInfo.appVersion')}</dt>
              <dd data-testid="app-version">{state.info.appVersion}</dd>
              <dt>{t('appInfo.coreVersion')}</dt>
              <dd data-testid="core-version">{state.info.coreVersion}</dd>
              <dt>{t('appInfo.dataDir')}</dt>
              <dd data-testid="data-dir">{state.info.dataDir}</dd>
            </dl>
          )}
        </div>
      </Panel>
      <div className="placeholder-view__preview" />
    </div>
  );
}
