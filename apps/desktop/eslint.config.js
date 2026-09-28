// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // bindings.ts is generated from the Rust types (crates/folio-app/src/ipc.rs).
  globalIgnores(['dist/', 'src/ipc/bindings.ts']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat['recommended-latest'],
  i18next.configs['flat/recommended'],
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // No hard-coded UI strings (CLAUDE.md §2): user-visible text comes from src/i18n/locales.
      'i18next/no-literal-string': ['error', { framework: 'react', mode: 'jsx-only' }],
      // Dates, times and numbers follow the UI language, never the Windows locale (src/i18n/README.md).
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ":matches(CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/], :matches(CallExpression, NewExpression)[callee.object.name='Intl']):matches([arguments.length=0], [arguments.0.type='Identifier'][arguments.0.name='undefined'])",
          message: 'Pass the UI language (i18n.language): without it, Windows chooses the locale.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: { 'i18next/no-literal-string': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
