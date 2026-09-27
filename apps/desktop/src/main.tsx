import './base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { initI18n } from './i18n';

await initI18n();

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html must contain an element with id "root"');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
