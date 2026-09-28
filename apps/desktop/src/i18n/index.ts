import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { defaultNS, en } from './resources';

// All user-visible strings live in locales/ (CLAUDE.md §2, README.md). v1 ships English only.

/** Loads the UI strings. Runs once before the first render (main.tsx) and in the test setup. */
export async function initI18n(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS,
    // React already escapes rendered text.
    interpolation: { escapeValue: false },
  });
}
