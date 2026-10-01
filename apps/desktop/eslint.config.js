// @ts-check
import js from '@eslint/js';
import pluginQuery from '@tanstack/eslint-plugin-query';
import { defineConfig, globalIgnores } from 'eslint/config';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Feature folders (docs/specs/ui-architecture.md §4): one per view or dialog, each owned by one lane.
const FEATURES = [
  'library',
  'search',
  'preview',
  'settings',
  'import',
  'first-run',
  'changes',
  'history',
  'diff',
  'sync',
  'conflicts',
  'remote-setup',
];

// The code that runs inside the sandboxed preview frame, the only place that may parse file
// content as HTML (ui-architecture §14 rule 1).
const FRAME = ['src/preview/frame.ts', 'src/preview/frame/**'];

// Dates, times and numbers follow the UI language, never the Windows locale (src/i18n/README.md).
const LOCALE_RULE = {
  selector:
    ":matches(CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/], :matches(CallExpression, NewExpression)[callee.object.name='Intl']):matches([arguments.length=0], [arguments.0.type='Identifier'][arguments.0.name='undefined'])",
  message: 'Pass the UI language (i18n.language): without it, Windows chooses the locale.',
};

// The window never parses library data as HTML (ui-architecture §14 rule 1): names, search spans
// and file content render as text; only the sandboxed frame builds markup.
const HTML_RULES = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Render text, never HTML (ui-architecture §14). Markup is built only inside the preview frame.',
  },
  {
    selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
    message: 'Use textContent or React children; HTML is parsed only inside the preview frame (§14).',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)$/]",
    message: 'HTML is parsed only inside the preview frame (ui-architecture §14).',
  },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^write(ln)?$/]",
    message: 'document.write parses HTML; it is not allowed (ui-architecture §14).',
  },
  {
    selector: "NewExpression[callee.name='DOMParser']",
    message: 'DOMParser parses HTML; only the preview frame may (ui-architecture §14).',
  },
  {
    selector: "JSXAttribute[name.name=/^src[dD]oc$/]",
    message: 'srcdoc would run markup in the window’s origin; the preview frame loads from folio-preview (§14).',
  },
];

// Only PreviewFrame renders an <iframe>, always sandboxed to scripts alone (§14 rule 2); no
// <object> or <embed> (rule 3); links never navigate the window (rule 6).
const FRAME_ELEMENT_RULES = [
  {
    selector: "JSXOpeningElement[name.name='iframe']",
    message: 'Only src/preview/PreviewFrame.tsx renders an <iframe> (ui-architecture §14).',
  },
  {
    selector: "CallExpression[callee.property.name='createElement'][arguments.0.value='iframe']",
    message: 'Only src/preview/PreviewFrame.tsx renders an <iframe> (ui-architecture §14).',
  },
];
const EMBED_RULES = [
  {
    selector: "JSXOpeningElement[name.name=/^(object|embed)$/]",
    message: 'Show library files only through <img>, <audio> and <video> with folio-file URLs (§14).',
  },
  {
    selector: ':matches(Literal[value=/allow-same-origin/], TemplateElement[value.raw=/allow-same-origin/])',
    message: 'The preview frame keeps an opaque origin: never allow-same-origin (ui-architecture §14).',
  },
  {
    selector: "CallExpression[callee.object.name='window'][callee.property.name='open']",
    message: 'Links from files never navigate anything (ui-architecture §14 rule 6).',
  },
];
const SANDBOX_RULE = {
  selector: "JSXOpeningElement[name.name='iframe']:not(:has(JSXAttribute[name.name='sandbox'][value.value='allow-scripts']))",
  message: 'The preview frame needs sandbox="allow-scripts" and nothing more (ui-architecture §14).',
};

/** Import paths that climb out of a folder into `folder`; `./name` stays inside the folder. */
const into = (folder) => `^(\\.\\./)+(${folder})(/|$)`;

// Folder rules (ui-architecture §3): what each layer may import.
const IPC_CALLS = {
  regex: '(^|/)ipc(/index)?$',
  importNames: ['ipc', 'shellEvents', 'windowControls', 'setWindowFailureHandler'],
  message: 'Features read through data/ hooks and act through data/ mutations, never ipc commands (§3 rule 1).',
};
const IPC_INTERNALS = {
  regex: '(^|/)ipc/(bindings|events|window|mock)(/|$)',
  message: 'Import from ipc (its index) only; the bindings, events and fake shell are not for features (§3).',
};

export default defineConfig([
  // bindings.ts is generated from the Rust types (crates/folio-app/src/ipc.rs).
  globalIgnores(['dist/', 'src/ipc/bindings.ts']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat['recommended-latest'],
  i18next.configs['flat/recommended'],
  // TanStack Query: keys cover what each query function reads, a stable client, and the rest of
  // the plugin's recommended rules (ui-architecture §5).
  pluginQuery.configs['flat/recommended'],
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // No hard-coded UI strings (CLAUDE.md §2): user-visible text comes from src/i18n/locales.
      // The attributes left out hold names from code, never words a user reads.
      'i18next/no-literal-string': [
        'error',
        {
          framework: 'react',
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className',
              'styleName',
              'style',
              'type',
              'key',
              'id',
              'width',
              'height',
              'slot',
              'source',
              'data-.+',
              'viewBox',
              'd',
              'transform',
            ],
          },
        },
      ],
      'no-restricted-syntax': [
        'error',
        LOCALE_RULE,
        ...HTML_RULES,
        ...FRAME_ELEMENT_RULES,
        ...EMBED_RULES,
      ],
      // No eval, new Function or string timers anywhere (§14 rule 5; no-implied-eval comes with
      // strictTypeChecked).
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },
  // The one component that renders the preview frame.
  {
    files: ['src/preview/PreviewFrame.tsx'],
    rules: {
      'no-restricted-syntax': ['error', LOCALE_RULE, ...HTML_RULES, ...EMBED_RULES, SANDBOX_RULE],
    },
  },
  // Inside the sandboxed frame: it builds the rendered file's DOM itself, and imports only the
  // protocol, lib/ and its renderer packages (§3 rule 4).
  {
    files: FRAME,
    rules: {
      'no-restricted-syntax': ['error', LOCALE_RULE, ...FRAME_ELEMENT_RULES, ...EMBED_RULES],
      'no-restricted-imports': [
        'error',
        {
          paths: ['react', 'react-dom', 'react-i18next', 'i18next'].map((name) => ({
            name,
            message: 'The preview frame imports only preview/protocol.ts, lib/ and its renderers (§3 rule 4).',
          })),
          patterns: [
            {
              regex: '^@tauri-apps/|(^|/)(ipc|data|i18n|app|components)(/|$)',
              message: 'The preview frame has no IPC, no data layer and no UI strings (§3 rule 4).',
            },
          ],
        },
      ],
    },
  },
  // Features: never each other (cross-feature actions go through app/navigation.ts), never ipc
  // commands (§3 rules 1 and 2).
  ...FEATURES.map((feature) => ({
    files: [`src/${feature}/**`],
    ignores: FRAME,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            IPC_CALLS,
            IPC_INTERNALS,
            {
              regex: into(FEATURES.filter((other) => other !== feature).join('|')),
              message: 'Features never import each other; go through the navigation store (§3 rule 2).',
            },
          ],
        },
      ],
    },
  })),
  // components/: presentational (§3 rule 3). No stores, no data hooks, no features; ipc types only.
  {
    files: ['src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['zustand', '@tanstack/react-query'].map((name) => ({
            name,
            message: 'components/ is presentational: data and state come in as props (§3 rule 3).',
          })),
          patterns: [
            {
              regex: into(['app', 'data', ...FEATURES].join('|')),
              message: 'components/ is presentational: no stores, data hooks or features (§3 rule 3).',
            },
            { regex: '(^|/)ipc(/|$)', allowTypeImports: true, message: 'components/ uses ipc types only.' },
          ],
        },
      ],
    },
  },
  // lib/: pure helpers, no React and no app layers; ipc types only.
  {
    files: ['src/lib/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['react', 'react-dom', 'zustand', '@tanstack/react-query', 'i18next', 'react-i18next'].map(
            (name) => ({ name, message: 'lib/ holds pure helpers (ui-architecture §4).' }),
          ),
          patterns: [
            {
              regex: into(['app', 'components', 'data', ...FEATURES].join('|')),
              message: 'lib/ holds pure helpers; it imports only other lib/ files (ui-architecture §4).',
            },
            { regex: '(^|/)ipc(/|$)', allowTypeImports: true, message: 'lib/ uses ipc types only.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  // The dev gallery (gallery.html, never built) labels its samples in plain English.
  {
    files: ['src/app/gallery/**'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // This file names the forbidden sandbox token in its own selectors.
  {
    files: ['eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]);
