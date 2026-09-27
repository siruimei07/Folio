import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App';
import zhCN from './i18n/locales/zh-CN.json';
import { ipc } from './ipc';

vi.mock('./ipc', { spy: true });

describe('App', () => {
  it('shows the versions and data directory reported by the shell', async () => {
    vi.mocked(ipc.appInfo).mockResolvedValue({
      status: 'ok',
      data: { appVersion: '0.1.0', coreVersion: '0.1.0', dataDir: 'C:\\Folio' },
    });

    render(<App />);

    expect(await screen.findByTestId('app-version')).toHaveTextContent('0.1.0');
    expect(screen.getByTestId('data-dir')).toHaveTextContent('C:\\Folio');
  });

  it('shows the message for a typed command error', async () => {
    vi.mocked(ipc.appInfo).mockResolvedValue({
      status: 'error',
      error: { code: 'DataDirUnavailable', detail: 'no local app data' },
    });

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(zhCN.errors.DataDirUnavailable);
  });

  it('shows the message for a failed IPC call', async () => {
    vi.mocked(ipc.appInfo).mockResolvedValue({
      status: 'error',
      error: { code: 'Transport', detail: 'IPC unavailable' },
    });

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(zhCN.errors.Transport);
  });
});
