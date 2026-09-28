import type { defaultNS, en } from './resources';

// Types every `t()` key against the en strings, so a missing string fails `tsc`. A .ts file rather
// than a .d.ts, which skipLibCheck would leave unchecked.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: typeof en;
  }
}
