import './base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { startAppearance } from './app/appearance';
import { boundarySource } from './app/ErrorBoundary';
import { watchLayout } from './app/layout';
import { reportUiError, reportUncaughtErrors } from './app/log';
import { createQueryClient } from './data/client';
import { DataProvider } from './data/DataProvider';
import { initI18n } from './i18n';

// A dev server page outside Tauri is the browser pane: a fake shell stands in for the real one
// (UI architecture §11.2). Production builds drop this, since `import.meta.env.DEV` is false there.
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  const { installFakeShell, optionsFromUrl } = await import('./ipc/mock');
  installFakeShell(optionsFromUrl(window.location.search));
}

// Theme, reduced motion and layout are attributes on the root that every stylesheet reads, so the
// first frame must already have them (UI architecture §6.3). The appearance follows App settings
// for as long as the window lives; its settings load while the strings do.
const appearance = startAppearance();
await initI18n();
await appearance;
watchLayout();
reportUncaughtErrors();

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html must contain an element with id "root"');
}

createRoot(container, {
  onUncaughtError: (error, info) => {
    reportUiError('uncaught', 'react', error, info.componentStack);
  },
  onCaughtError: (error, info) => {
    reportUiError('boundary', boundarySource(info), error, info.componentStack);
  },
}).render(
  <StrictMode>
    <DataProvider client={createQueryClient()}>
      <App />
    </DataProvider>
  </StrictMode>,
);
