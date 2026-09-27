import { defineConfig } from '@playwright/test';

// Tests drive the real app over WebView2 CDP (docs/specs/testing-strategy.md). Build the debug
// app first with `pnpm build:app`; `pnpm e2e` at the repo root does both.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Every test starts its own app with its own profile and data (fixtures.ts).
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});
