/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Tauri loads the dev server from a fixed URL (crates/folio-app/tauri.conf.json).
  server: { port: 5173, strictPort: true },
  // The app runs in WebView2 (current Chromium).
  build: { target: 'es2023' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Every test starts from unmocked behaviour, so no test file needs its own reset hook.
    mockReset: true,
  },
});
