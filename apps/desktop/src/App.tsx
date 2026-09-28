import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type AppInfo, type IpcError, ipc } from './ipc';
import { TitleBar } from './titlebar/TitleBar';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; info: AppInfo }
  | { kind: 'failed'; error: IpcError };

/**
 * Placeholder screen until the first design handoff. It proves the path
 * UI → IPC → Rust end to end; real screens start from docs/design/handoff/.
 */
export function App() {
  const { t } = useTranslation(['shell', 'common', 'errors']);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void ipc.appInfo().then((result) => {
      if (!active) return;
      setState(
        result.status === 'ok'
          ? { kind: 'ready', info: result.data }
          : { kind: 'failed', error: result.error },
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <TitleBar />
      <main>
        <h1>{t('common:app.name')}</h1>
        {state.kind === 'loading' && <p>{t('appInfo.loading')}</p>}
        {state.kind === 'failed' && <p role="alert">{t(`errors:${state.error.code}`)}</p>}
        {state.kind === 'ready' && (
          <dl>
            <dt>{t('appInfo.appVersion')}</dt>
            <dd data-testid="app-version">{state.info.appVersion}</dd>
            <dt>{t('appInfo.coreVersion')}</dt>
            <dd data-testid="core-version">{state.info.coreVersion}</dd>
            <dt>{t('appInfo.dataDir')}</dt>
            <dd data-testid="data-dir">{state.info.dataDir}</dd>
          </dl>
        )}
      </main>
    </>
  );
}
