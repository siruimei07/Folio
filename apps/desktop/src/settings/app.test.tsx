// App settings (app-shell handoff §9; ipc-m1 §22.1) against the fake shell: the device name with
// its checks and failures, the theme and reduce motion, which apply at once, and the shortcuts.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { announced, renderSettings } from './test/render';
import { toastTexts } from '../test/render';

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.reduceMotion;
});

describe('App settings → General', () => {
  it('opens on General with focus on its item, and saves a new device name', async () => {
    const { user, shell } = renderSettings('appSettings', undefined);
    const dialog = await screen.findByRole('dialog', { name: 'App settings' });
    await waitFor(() => {
      expect(within(dialog).getByRole('tab', { name: 'General' })).toHaveFocus();
    });
    const field = within(dialog).getByRole('textbox', { name: 'Device name' });
    expect(field).toHaveValue('G16');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, 'Desktop{Enter}');
    await waitFor(() => {
      expect(shell.appSettings.deviceName).toBe('Desktop');
    });
    expect(announced()).toBe('Saved the device name.');
    expect(within(dialog).getByText('D')).toBeInTheDocument();
  });

  it('flags an empty name before sending it', async () => {
    const { user, shell } = renderSettings('appSettings', undefined);
    const field = await screen.findByRole('textbox', { name: 'Device name' });
    await user.clear(field);
    await user.type(field, '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(field).toHaveAccessibleDescription(/Enter a name for this computer\./);
    expect(shell.appSettings.deviceName).toBe('G16');
  });

  it('says why a save failed', async () => {
    const { user, shell } = renderSettings('appSettings', undefined);
    shell.setFailure('update_app_settings', 'DataDirUnavailable');
    const field = await screen.findByRole('textbox', { name: 'Device name' });
    await user.type(field, ' laptop{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the device name");
    expect(field).toHaveValue('G16 laptop');
  });

  it('shows the state block when the settings cannot be read', async () => {
    renderSettings('appSettings', undefined, { fail: [{ command: 'get_app_settings', code: 'DataDirUnavailable' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load the App settings" })).toBeInTheDocument();
  });
});

describe('App settings → Appearance', () => {
  it('applies a theme at once and saves it', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'appearance' });
    const dark = await screen.findByRole('radio', { name: 'Dark' });
    await user.click(dark);
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(shell.appSettings.theme).toBe('dark');
    expect(dark).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'System' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBeUndefined();
    });
  });

  it('turns reduce motion on at once', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'appearance' });
    await user.click(await screen.findByRole('button', { name: /Reduce motion/ }));
    await user.click(await screen.findByRole('option', { name: 'On' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.reduceMotion).toBe('on');
    });
    expect(shell.appSettings.reduceMotion).toBe('on');
  });

  it('puts the control back and says so when a save fails', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'appearance' });
    shell.setFailure('update_app_settings', 'DataDirUnavailable');
    await user.click(await screen.findByRole('radio', { name: 'Light' }));
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't change the appearance"))).toBe(true);
    });
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('names the ten colours', async () => {
    renderSettings('appSettings', { page: 'appearance' });
    const colours = await screen.findByRole('list', { name: 'The ten colours' });
    expect(within(colours).getAllByRole('listitem')).toHaveLength(10);
  });
});

describe('App settings → Keyboard', () => {
  it('lists the shortcuts with their keys', async () => {
    renderSettings('appSettings', { page: 'keyboard' });
    expect(await screen.findByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+1')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+,')).toBeInTheDocument();
  });
});
