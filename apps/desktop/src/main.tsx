import './base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyAppearance, DEFAULT_APPEARANCE } from './app/appearance';
import { boundarySource } from './app/ErrorBoundary';
import { watchLayout } from './app/layout';
import { reportUiError, reportUncaughtErrors } from './app/log';
import { initI18n } from './i18n';

await initI18n();

// Theme, reduced motion and layout are attributes on the root that every stylesheet reads, so the
// first frame must already have them (UI architecture §6.3).
applyAppearance(DEFAULT_APPEARANCE);
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
    <App />
  </StrictMode>,
);
