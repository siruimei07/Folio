# UI strings

Every user-visible string comes from here (CLAUDE.md §2); ESLint's `i18next/no-literal-string`
rejects text written into JSX.

| File | Role |
|---|---|
| `locales/en/<namespace>.json` | The English strings: the only locale in v1, the default and the fallback |
| `resources.ts` | The namespace list and the default namespace, used by the runtime and by the types |
| `i18next.ts` | Types every `t()` key against `en`, so `tsc` fails on a key `en` lacks (`i18n.test.ts` checks that this still holds) |
| `index.ts` | `initI18n()`, run before the first render (`main.tsx`) and in the test setup |

The UI language is fixed to `en`; it never follows the Windows display language.

## Namespaces

One per view, so that parallel UI lanes add strings to different files. Every UI lane on the
roadmap (`docs/product/roadmap.md` §5) has its namespace already, named after its view.

| Namespace | Holds |
|---|---|
| `common` | The product name and strings that shared components need |
| `errors` | One message per `AppError` code, plus `Transport`, in the enum's order; `tsc` fails until a new code has one |
| `titlebar` | Caption buttons |
| `shell` | Toolbar, rail, window layout, failed window commands; for now the placeholder app-info screen |
| `library` | Library view: tree, tag filter, quick views, context menus |
| `search` | Search dialog |
| `preview` | Preview pane, including Office previews |
| `import` | Drop target, import dialog, progress |
| `settings` | Library settings and App settings |
| `first-run` | Welcome, new library or take over a folder, first semester and courses; later the onboarding |
| `diff` | The diff viewer that Changes and History share |
| `changes` | Changes view |
| `history` | History view |
| `sync` | Toolbar sync status, progress and results |
| `conflicts` | Conflict resolution |
| `remote-setup` | Creating and joining a cloud remote |
| `problems` | The problems list that "View problems" opens (library-actions §11) |

Rules:

- Add strings to your view's namespace, even when another view has the same text. A string moves
  to `common` only when a shared component needs it.
- A component names its own namespace first and the others after it:
  `useTranslation(['library', 'common', 'errors'])`, then `t('title')`, `t('common:app.name')` and
  ``t(`errors:${error.code}`)``.
- A view the roadmap does not list gets a new JSON file and one line in `resources.ts`. Do that in
  a lane of its own or at a sync point: parallel lanes would collide on that list.
- Keys are camelCase, nested by area (`tree.emptyCourse`). Use the English source copy in the
  handoff specs (`docs/design/handoff/`); write new copy with `design:ux-copy`, in sentence case.
- Plurals use i18next's suffixes with `count` (`commitChanges_one`, `commitChanges_other`); never
  build a sentence from fragments.
- Format dates, times and numbers in the UI language: `{{when, datetime}}` or `{{size, number}}`
  inside a string, or `toLocale…String` and `Intl` with `i18n.language` in code. ESLint rejects
  them without a locale, which on a Chinese Windows would put Chinese dates into the English UI.
  `en` gives the formats the brief asks for (`Sep 27`, `5:05 PM`).

## Simplified Chinese

Decided 2026-09-28: `zh-CN` does not stay as a second locale until the Chinese UI version. v1
cannot switch languages, so it would never show, and keeping it current would double every UI
lane's copy work. The Chinese strings written so far are in git
(`git show a4b1956:apps/desktop/src/i18n/locales/zh-CN.json`). The Chinese UI version adds
`locales/zh-CN/`, a language setting, `<html lang>` that follows it, and a test that every locale
has the keys of `en`.
