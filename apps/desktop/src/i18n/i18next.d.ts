import 'i18next';

import type zhCN from './locales/zh-CN.json';

// Types every `t()` key against zh-CN.json, so a missing string fails `tsc`.
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof zhCN };
  }
}
