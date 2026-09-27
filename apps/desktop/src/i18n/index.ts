import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN from './locales/zh-CN.json';

// All user-visible strings live in locales/ (CLAUDE.md §2). v1 ships Simplified Chinese only.

/** Loads the UI strings. Runs once before the first render (main.tsx) and in the test setup. */
export async function initI18n(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: { 'zh-CN': { translation: zhCN } },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    // React already escapes rendered text.
    interpolation: { escapeValue: false },
  });
}
