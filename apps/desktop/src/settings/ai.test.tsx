// App settings → AI (app-shell handoff §9; ipc-m2 §12) against the fake shell: the page's place
// and its loading and failure states, the two switches, each saving its own field, the
// service, address and model, and the write-only API key and its test.
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { announce } from '../app/announcer';
import { openDialog } from '../app/navigation';
import { keys } from '../data/keys';
import { type AiSettings, DEFAULT_AI_ENDPOINT, type UpdateAiSettings } from '../ipc';
import { LOADING_DELAY_MS } from '../lib/timing';
import { toastTexts } from '../test/render';
import { renderSettings, settingsDialog } from './test/render';

/**
 * The app's polite live region. The shared `announced()` reads the first polite region in the
 * page, which is React Aria's own once any pending button has announced into it (Remove key, Test
 * key), and that region stays in the body across tests: every check here reads the app's own.
 */
function announcedHere(): string {
  return document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? '';
}

// The app's live regions read a module-level store, which outlives each test's render: empty it,
// so a check of what was announced never passes on the previous test's last message.
beforeEach(() => {
  announce('');
});

/** Another service's address, and the update that stores it. */
const OTHER_URL = 'https://ai.example.test/v1';
const TO_OTHER: UpdateAiSettings = { enabled: null, endpoint: OTHER_URL, model: null, sendContent: null };

const AI_SWITCH = 'Write commit messages with AI';
const SEND_SWITCH = 'Send changed text';

describe('App settings → AI', () => {
  it('sits between Appearance and Keyboard and opens with focus on its tab', async () => {
    renderSettings('appSettings', { page: 'ai' });
    const dialog = await screen.findByRole('dialog', { name: 'App settings' });
    const tab = within(dialog).getByRole('tab', { name: 'AI' });
    await waitFor(() => {
      expect(tab).toHaveFocus();
    });
    expect(within(dialog).getAllByRole('tab').map((item) => item.textContent)).toEqual([
      'General',
      'Appearance',
      'AI',
      'Keyboard',
    ]);
    expect(await within(dialog).findByRole('switch', { name: AI_SWITCH })).toBeChecked();
    expect(within(dialog).getByRole('switch', { name: SEND_SWITCH })).toBeChecked();
  });

  it('says what is sent and that commits work without AI', async () => {
    renderSettings('appSettings', { page: 'ai' });
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    expect(ai).toHaveAccessibleDescription(/DeepSeek writes one\. You can always commit without AI/);
    expect(screen.getByRole('switch', { name: SEND_SWITCH })).toHaveAccessibleDescription(
      /changed lines of text and Word files.*PDFs, slides, spreadsheets and images are never sent\./,
    );
  });

  it('names the AI service when the endpoint is not DeepSeek', async () => {
    const { shell } = renderSettings('appSettings', { page: 'ai' });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    await waitFor(() => {
      expect(ai).toHaveAccessibleDescription(/the AI service writes one/);
    });
  });

  it('shows the skeleton while the settings load', async () => {
    renderSettings('appSettings', { page: 'ai' }, { latencyMs: LOADING_DELAY_MS * 4 });
    // General stays mounted and loads too: look in the AI page only.
    const page = await screen.findByRole('tabpanel', { name: 'AI' });
    expect(await within(page).findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(within(page).queryByRole('switch', { name: AI_SWITCH })).toBeNull();
    expect(await screen.findByRole('switch', { name: AI_SWITCH }, { timeout: LOADING_DELAY_MS * 10 })).toBeChecked();
  });

  it('shows the state block when the settings cannot be read, and tries again', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, {
      fail: [{ command: 'get_ai_settings', code: 'DataDirUnavailable' }],
    });
    expect(await screen.findByRole('heading', { name: "Couldn't load the AI settings" })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    shell.setFailure('get_ai_settings', null);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: AI_SWITCH })).toBeChecked();
  });

  it('saves each switch on its own', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    await user.click(ai);
    expect(ai).not.toBeChecked();
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ enabled: false, sendContent: true });
    });
    const send = screen.getByRole('switch', { name: SEND_SWITCH });
    await user.click(send);
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ enabled: false, sendContent: false });
    });
    expect(send).not.toBeChecked();
    expect(ai).not.toBeChecked();
    await user.click(ai);
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ enabled: true, sendContent: false });
    });
    expect(ai).toBeChecked();
  });

  it('keeps showing the latest choice while an earlier save of the same switch answers', async () => {
    // Both saves' answers wait until released; each change's event comes at once.
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' });
    const saves = holdAnswers(shell, 'update_ai_settings');
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    const cached = () => client.getQueryData<AiSettings>(keys.aiSettings())?.enabled;
    await user.click(ai);
    await user.click(ai);
    await waitFor(() => {
      expect(cached()).toBe(true);
    });
    // The first save's answer (off) reaches the cache while the second save still runs.
    await saves.release();
    expect(cached()).toBe(false);
    expect(ai).toBeChecked();
    await saves.release();
    expect(cached()).toBe(true);
    expect(ai).toBeChecked();
    expect(saves.calls()).toBe(2);
  });

  it('puts a switch back and says so when its save fails', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    const send = await screen.findByRole('switch', { name: SEND_SWITCH });
    shell.setFailure('update_ai_settings', 'DataDirUnavailable');
    await user.click(send);
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't turn off sending changed text"))).toBe(true);
    });
    expect(send).toBeChecked();
    expect(shell.ai.settings().sendContent).toBe(true);
  });

  it('shows AI off in the ai-off scenario, and turning it on can fail too', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    expect(ai).not.toBeChecked();
    // The controls stay usable while AI is off.
    expect(screen.getByRole('switch', { name: SEND_SWITCH })).toBeEnabled();
    shell.setFailure('update_ai_settings', 'DataDirUnavailable');
    await user.click(ai);
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't turn on AI commit messages"))).toBe(true);
    });
    expect(ai).not.toBeChecked();
  });

  it('follows a change made elsewhere', async () => {
    const { shell } = renderSettings('appSettings', { page: 'ai' });
    const ai = await screen.findByRole('switch', { name: AI_SWITCH });
    act(() => {
      shell.ai.update({ enabled: false, endpoint: null, model: null, sendContent: false });
    });
    await waitFor(() => {
      expect(ai).not.toBeChecked();
    });
    expect(within(settingsDialog('App settings')).getByRole('switch', { name: SEND_SWITCH })).not.toBeChecked();
  });
});

const OTHER = 'OpenAI-compatible service';
/** The key card's line while the other service is chosen and its address not saved yet. */
const ADDRESS_FIRST = 'Save the address first, then add a key for this service.';

/** Picks a service in the Service select. */
async function chooseService(user: UserEvent, name: 'DeepSeek' | typeof OTHER) {
  await user.click(await screen.findByRole('button', { name: /Service/ }));
  await user.click(await screen.findByRole('option', { name }));
}

/** The Save button after the field `label`. */
function saveButton(label: 'Address' | 'Model'): HTMLElement {
  const field = screen.getByRole('textbox', { name: label }).closest('.field');
  if (!(field instanceof HTMLElement)) throw new Error(`no field ${label}`);
  return within(field).getByRole('button', { name: 'Save' });
}

/** Waits `ms` of real time. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type Shell = ReturnType<typeof renderSettings>['shell'];

/**
 * Holds the fake shell's answers to `command` until the test lets each through, oldest first. The
 * shell still acts at once and its events go out, as with `latencyMs` (ui-architecture §5.4); only
 * the answer waits. Tests that act while a call runs use this instead of a latency, so a slow
 * runner can never let the answer arrive before the clicks that must come first.
 */
function holdAnswers(shell: Shell, command: Parameters<Shell['setFailure']>[0]) {
  const held: { settled: Promise<unknown>; deliver: () => void }[] = [];
  let calls = 0;
  const invoke = shell.invoke.bind(shell);
  shell.invoke = (name, payload) => {
    const answer = invoke(name, payload);
    if (name !== command) return answer;
    calls += 1;
    return new Promise((resolve, reject) => {
      held.push({
        // Caught at once, so a held failure is not reported as an unhandled rejection.
        settled: answer.catch(() => undefined),
        deliver: () => {
          answer.then(resolve, reject);
        },
      });
    });
  };
  return {
    /** How many calls of `command` reached the shell. */
    calls: () => calls,
    /** Lets the oldest held answer reach the page after the events sent so far (waiting for its call first). */
    async release() {
      await waitFor(() => {
        expect(held.length, `a held ${command} answer`).toBeGreaterThan(0);
      });
      const next = held.shift();
      if (next === undefined) throw new Error(`no ${command} answer is held`);
      await act(async () => {
        // The events overtake the answer, as with a latency.
        await shell.flush();
        next.deliver();
        await next.settled;
        // A timer runs only after every promise job queued before it: the first pause lets the
        // answer through the ipc and data layers, the second the query cache's notifications,
        // which TanStack Query sends on a timer.
        await pause(0);
        await pause(0);
      });
    },
  };
}

/** Lets two animation frames pass, so React Aria's focus restore after a dialog closes has run. */
async function frames() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

/** The page shows DeepSeek: the select, no Address field, and DeepSeek's key card. */
async function expectOnDeepSeek({ hasKey }: { hasKey: boolean }) {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent('DeepSeek');
  });
  expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull();
  expect(screen.queryByText(ADDRESS_FIRST)).toBeNull();
  expect(screen.getByRole('heading', { name: 'DeepSeek API key' })).toBeInTheDocument();
  if (hasKey) expect(screen.getByText('A key is saved')).toBeInTheDocument();
  else expect(screen.getByLabelText('Key')).toBeInTheDocument();
}

/**
 * React Aria's useDialog focuses the settings dialog itself 500 ms after it opens when focus is on
 * the body then (a VoiceOver workaround). A test that closes an alert dialog within that time can
 * hit the moment between the alert closing and React Aria's focus restore, which a person never
 * does; tests that check where focus goes after an alert wait it out first.
 */
async function pastDialogRefocus() {
  await act(() => pause(600));
}

/** Types `text` into the field `label` in place of what it shows. */
async function retype(user: UserEvent, label: 'Address' | 'Model', text: string) {
  const input = screen.getByRole('textbox', { name: label });
  await user.clear(input);
  await user.type(input, text);
}

/** Stores the other service's address with a key for it elsewhere, then waits for the page to show both. */
async function moveToOtherWithKey(shell: Shell) {
  await screen.findByRole('button', { name: /Service/ });
  act(() => {
    shell.ai.update(TO_OTHER);
    shell.ai.setKey('fake-test-key-not-real');
  });
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveAccessibleDescription(/removes the saved API key/);
  });
}

describe('App settings → AI → service and model', () => {
  it('switches to an OpenAI-compatible service after asking, storing the address normalised', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    expect(await screen.findByRole('button', { name: /Service/ })).toHaveTextContent('DeepSeek');
    expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull();
    await chooseService(user, OTHER);
    const address = screen.getByRole('textbox', { name: 'Address' });
    expect(address).toHaveValue('');
    expect(address).toHaveAccessibleDescription(/An address on another server removes the saved API key\./);
    expect(saveButton('Address')).toBeDisabled();
    await user.type(address, ' HTTPS://AI.Example.test/v1/ ');
    await user.click(saveButton('Address'));
    const confirm = await screen.findByRole('alertdialog', { name: 'Switch to another service?' });
    expect(confirm).toHaveAccessibleDescription(/saved DeepSeek API key works only with DeepSeek, so Folio removes it/);
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Nothing changes until the user confirms.
    expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    await pastDialogRefocus();
    await user.click(within(confirm).getByRole('button', { name: 'Switch and remove key' }));
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: OTHER_URL, hasKey: false });
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(OTHER_URL);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    expect(announcedHere()).toBe('Address saved. The old API key was removed.');
    await frames();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveFocus();
    expect(screen.getByRole('switch', { name: AI_SWITCH })).toHaveAccessibleDescription(/the AI service writes one/);
  });

  it('changes nothing when the confirmation is cancelled', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await chooseService(user, OTHER);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Switch to another service?' });
    await pastDialogRefocus();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    // What the user typed stays, so they can save it or go back to DeepSeek.
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(OTHER_URL);
    // The page still speaks for the service the select shows.
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    expect(screen.getByRole('switch', { name: AI_SWITCH })).toHaveAccessibleDescription(/the AI service writes one/);
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    // Focus goes back to where the save started.
    await frames();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveFocus();
  });

  it('goes back to DeepSeek without storing anything when the address was not saved', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await chooseService(user, OTHER);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await chooseService(user, 'DeepSeek');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull();
    expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    // The abandoned address is gone when the other service is chosen again.
    await chooseService(user, OTHER);
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('');
    expect(saveButton('Address')).toBeDisabled();
  });

  it('asks before switching back to DeepSeek with a key saved, then sends the default endpoint', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await moveToOtherWithKey(shell);
    await chooseService(user, 'DeepSeek');
    let confirm = await screen.findByRole('alertdialog', { name: 'Switch to DeepSeek?' });
    expect(confirm).toHaveAccessibleDescription(/works only with the current service, so Folio removes it/);
    await pastDialogRefocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(shell.ai.settings()).toMatchObject({ endpoint: OTHER_URL, hasKey: true });
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    await frames();
    expect(screen.getByRole('button', { name: /Service/ })).toHaveFocus();

    await chooseService(user, 'DeepSeek');
    confirm = await screen.findByRole('alertdialog', { name: 'Switch to DeepSeek?' });
    // By keyboard, so React Aria's focus restore is what puts focus back.
    await user.keyboard('{Tab}');
    expect(within(confirm).getByRole('button', { name: 'Switch and remove key' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: false });
    });
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent('DeepSeek');
    expect(announcedHere()).toBe('Switched to DeepSeek. The old API key was removed.');
    await frames();
    await frames();
    expect(screen.getByRole('button', { name: /Service/ })).toHaveFocus();
  });

  it('asks nothing when no key is saved', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await chooseService(user, OTHER);
    expect(screen.getByRole('textbox', { name: 'Address' })).not.toHaveAccessibleDescription(/removes/);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await user.click(saveButton('Address'));
    await waitFor(() => {
      expect(shell.ai.settings().endpoint).toBe(OTHER_URL);
    });
    expect(announcedHere()).toBe('Address saved');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await chooseService(user, 'DeepSeek');
    await waitFor(() => {
      expect(shell.ai.settings().endpoint).toBe(DEFAULT_AI_ENDPOINT);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(announcedHere()).toBe('Switched to DeepSeek');
    // The page is on DeepSeek again: the choice of the other service ended with the save.
    await expectOnDeepSeek({ hasKey: false });
  });

  it('shows an invalid address under the field and stores nothing', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await chooseService(user, OTHER);
    const address = screen.getByRole('textbox', { name: 'Address' });
    await user.type(address, 'http://ai.example.test');
    await user.click(saveButton('Address'));
    await waitFor(() => {
      expect(address).toHaveAccessibleDescription(/^Enter an https:\/\/ address, like https:\/\/api\.deepseek\.com/);
    });
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(address).toHaveFocus();
    expect(shell.ai.settings().endpoint).toBe(DEFAULT_AI_ENDPOINT);
    expect(toastTexts()).toEqual([]);
    // Typing clears the message.
    await user.type(address, 's');
    expect(address).not.toHaveAttribute('aria-invalid');
  });

  it.each(['https://me@api.example.com/v1', 'https://api.example.com/v1?', 'https://api.example.com/v1#', 'https://me@api.deepseek.com'])(
    'asks nothing about the key for %s, which the shell refuses, and keeps it',
    async (typed) => {
      const { user, shell } = renderSettings('appSettings', { page: 'ai' });
      await chooseService(user, OTHER);
      const address = screen.getByRole('textbox', { name: 'Address' });
      await user.type(address, typed);
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(address).toHaveAccessibleDescription(/^Enter an https:\/\/ address/);
      });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    },
  );

  it('saves the model trimmed', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    const model = await screen.findByRole('textbox', { name: 'Model' });
    expect(model).toHaveValue('deepseek-chat');
    expect(model).toHaveAccessibleDescription('The name of the model to use, like deepseek-chat.');
    expect(saveButton('Model')).toBeDisabled();
    await retype(user, 'Model', '  deepseek-reasoner  ');
    await user.click(saveButton('Model'));
    await waitFor(() => {
      expect(shell.ai.settings().model).toBe('deepseek-reasoner');
    });
    await waitFor(() => {
      expect(model).toHaveValue('deepseek-reasoner');
    });
    expect(saveButton('Model')).toBeDisabled();
    // The pressed Save turned off: focus goes back to the field.
    expect(model).toHaveFocus();
    expect(announcedHere()).toBe('Model saved');
    // The key stays: the model is not the service.
    expect(shell.ai.settings().hasKey).toBe(true);
  });

  it('shows an invalid model under the field and stores nothing', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await screen.findByRole('textbox', { name: 'Model' });
    await retype(user, 'Model', 'deep seek');
    await user.keyboard('{Enter}');
    const model = screen.getByRole('textbox', { name: 'Model' });
    await waitFor(() => {
      expect(model).toHaveAccessibleDescription(/^Enter a model name, like deepseek-chat, without spaces\./);
    });
    expect(shell.ai.settings().model).toBe('deepseek-chat');
  });

  it('shows a toast for any other failure', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await screen.findByRole('textbox', { name: 'Model' });
    shell.setFailure('update_ai_settings', 'DataDirUnavailable');
    await retype(user, 'Model', 'deepseek-reasoner');
    await user.click(saveButton('Model'));
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't save the model — "))).toBe(true);
    });
    const model = screen.getByRole('textbox', { name: 'Model' });
    expect(model).not.toHaveAttribute('aria-invalid');
    expect(model).toHaveValue('deepseek-reasoner');
    expect(shell.ai.settings().model).toBe('deepseek-chat');
  });

  it('stays on the other service when switching to DeepSeek fails', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await screen.findByRole('button', { name: /Service/ });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    await screen.findByRole('textbox', { name: 'Address' });
    shell.setFailure('update_ai_settings', 'DataDirUnavailable');
    await chooseService(user, 'DeepSeek');
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't switch to DeepSeek — "))).toBe(true);
    });
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    expect(shell.ai.settings().endpoint).toBe(OTHER_URL);
  });

  // The tests below act while a save runs: `holdAnswers` keeps its answer back until released,
  // while the change's events overtake it (as in the app).

  it('shows DeepSeek in the select while the switch runs, and the other service again when it fails', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    const saves = holdAnswers(shell, 'update_ai_settings');
    await screen.findByRole('button', { name: /Service/ });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    await screen.findByRole('textbox', { name: 'Address' });
    shell.setFailure('update_ai_settings', 'DataDirUnavailable');
    await chooseService(user, 'DeepSeek');
    // The failed save sends no event, so only the running switch makes the select read DeepSeek.
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent('DeepSeek');
    await saves.release();
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't switch to DeepSeek — "))).toBe(true);
    });
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
  });

  it('ignores another service picked while the switch to DeepSeek runs', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    const saves = holdAnswers(shell, 'update_ai_settings');
    await screen.findByRole('button', { name: /Service/ });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    await screen.findByRole('textbox', { name: 'Address' });
    await chooseService(user, 'DeepSeek');
    await chooseService(user, OTHER);
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent('DeepSeek');
    await saves.release();
    await waitFor(() => {
      expect(announcedHere()).toBe('Switched to DeepSeek');
    });
    expect(shell.ai.settings().endpoint).toBe(DEFAULT_AI_ENDPOINT);
    await expectOnDeepSeek({ hasKey: false });
    expect(saves.calls()).toBe(1);
  });

  it('ignores DeepSeek picked while an address saves', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    const saves = holdAnswers(shell, 'update_ai_settings');
    await chooseService(user, OTHER);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await user.keyboard('{Enter}');
    await chooseService(user, 'DeepSeek');
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    await saves.release();
    await waitFor(() => {
      expect(announcedHere()).toBe('Address saved');
    });
    // The pick started no switch: the shell acts at once, so one would show in its settings now.
    expect(saves.calls()).toBe(1);
    expect(shell.ai.settings().endpoint).toBe(OTHER_URL);
    expect(screen.getByRole('button', { name: /Service/ })).toHaveTextContent(OTHER);
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(OTHER_URL);
  });

  it('returns focus to the address after the switch is confirmed by keyboard', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await chooseService(user, OTHER);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Switch to another service?' });
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await pastDialogRefocus();
    await user.keyboard('{Tab}');
    expect(within(confirm).getByRole('button', { name: 'Switch and remove key' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: OTHER_URL, hasKey: false });
    });
    await frames();
    await frames();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close (Esc)' })).not.toHaveFocus();
  });

  it('asks before an address on another server removes the key, and not for a path on the same one', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await moveToOtherWithKey(shell);
    await retype(user, 'Address', 'https://ai.example.test/v2');
    await user.click(saveButton('Address'));
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: 'https://ai.example.test/v2', hasKey: true });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(announcedHere()).toBe('Address saved');
    });

    await retype(user, 'Address', 'https://other.example.test/v1');
    await user.click(saveButton('Address'));
    const confirm = await screen.findByRole('alertdialog', { name: 'Switch to another service?' });
    expect(confirm).toHaveAccessibleDescription(/^The saved API key works only with the current service, so Folio removes it\./);
    expect(shell.ai.settings()).toMatchObject({ endpoint: 'https://ai.example.test/v2', hasKey: true });
    await user.click(within(confirm).getByRole('button', { name: 'Switch and remove key' }));
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: 'https://other.example.test/v1', hasKey: false });
    });
    await waitFor(() => {
      expect(announcedHere()).toBe('Address saved. The old API key was removed.');
    });
  });

  it("keeps the key, and asks nothing, for another address on DeepSeek's server", async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await chooseService(user, OTHER);
    await user.type(screen.getByRole('textbox', { name: 'Address' }), `${DEFAULT_AI_ENDPOINT}/beta`);
    await user.click(saveButton('Address'));
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: `${DEFAULT_AI_ENDPOINT}/beta`, hasKey: true });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(announcedHere()).toBe('Address saved');
    });
    await chooseService(user, 'DeepSeek');
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(announcedHere()).toBe('Switched to DeepSeek');
    });
    // The page is on DeepSeek again, with the key it kept.
    await expectOnDeepSeek({ hasKey: true });
  });

  it.each([`${DEFAULT_AI_ENDPOINT}/`, 'HTTPS://API.DeepSeek.com', DEFAULT_AI_ENDPOINT])(
    "goes back to DeepSeek when DeepSeek's own address %s is saved from the other service",
    async (typed) => {
      const { user, shell } = renderSettings('appSettings', { page: 'ai' });
      await chooseService(user, OTHER);
      await user.type(screen.getByRole('textbox', { name: 'Address' }), typed);
      expect(saveButton('Address')).toBeEnabled();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(announcedHere()).toBe('Switched to DeepSeek');
      });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: true });
      await expectOnDeepSeek({ hasKey: true });
      expect(screen.getByRole('switch', { name: AI_SWITCH })).toHaveAccessibleDescription(/DeepSeek writes one/);
      await frames();
      expect(screen.getByRole('button', { name: /Service/ })).toHaveFocus();
    },
  );

  it("asks as a switch to DeepSeek when DeepSeek's address replaces another service's with a key saved", async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await moveToOtherWithKey(shell);
    await retype(user, 'Address', `${DEFAULT_AI_ENDPOINT}/`);
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Switch to DeepSeek?' });
    expect(confirm).toHaveAccessibleDescription(/works only with the current service, so Folio removes it/);
    await pastDialogRefocus();
    await user.keyboard('{Tab}');
    expect(within(confirm).getByRole('button', { name: 'Switch and remove key' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: DEFAULT_AI_ENDPOINT, hasKey: false });
    });
    await waitFor(() => {
      expect(announcedHere()).toBe('Switched to DeepSeek. The old API key was removed.');
    });
    await expectOnDeepSeek({ hasKey: false });
    await frames();
    await frames();
    expect(screen.getByRole('button', { name: /Service/ })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close (Esc)' })).not.toHaveFocus();
  });

  it("switches to DeepSeek, asking nothing, when DeepSeek's address replaces another service's without a key", async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await screen.findByRole('button', { name: /Service/ });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    await screen.findByRole('textbox', { name: 'Address' });
    await retype(user, 'Address', DEFAULT_AI_ENDPOINT);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shell.ai.settings().endpoint).toBe(DEFAULT_AI_ENDPOINT);
    });
    await waitFor(() => {
      expect(announcedHere()).toBe('Switched to DeepSeek');
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await expectOnDeepSeek({ hasKey: false });
    await frames();
    await frames();
    expect(screen.getByRole('button', { name: /Service/ })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close (Esc)' })).not.toHaveFocus();
  });
});

// Obviously fake: never a real key, here or anywhere.
const FAKE_KEY = 'sk-test-not-a-real-key';

/** The key's password input, by its label ("Key", or "New key" while replacing). */
function keyInput(label: 'Key' | 'New key' = 'Key'): HTMLInputElement {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input ${label}`);
  return input;
}

/** The Save button after the key's input. */
function keySave(label: 'Key' | 'New key' = 'Key'): HTMLElement {
  const field = keyInput(label).closest('.field');
  if (!(field instanceof HTMLElement)) throw new Error('no key field');
  return within(field).getByRole('button', { name: 'Save' });
}

/**
 * The page's markup (every node and attribute) and the values of its inputs, which markup leaves
 * out. Serialized, not read through `innerHTML`, which the app's lint rules keep out of the code.
 */
function pageState(): string {
  const values = [...document.querySelectorAll('input')].map((input) => input.value);
  return [new XMLSerializer().serializeToString(document.body), ...values].join(' ');
}

/** Asserts that the key is in no DOM node and no query or mutation state. */
function expectKeyNowhere(client: QueryClient, key: string) {
  expect(pageState()).not.toContain(key);
  expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state))).not.toContain(key);
  expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state))).not.toContain(key);
}

describe('App settings → AI → API key', () => {
  it('saves a key and then shows only that one is saved', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    expect(await screen.findByRole('heading', { name: 'DeepSeek API key' })).toBeInTheDocument();
    const input = keyInput();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAccessibleDescription('Stored in Windows Credential Manager, never in your library folder.');
    expect(keySave()).toBeDisabled();
    await user.type(input, FAKE_KEY);
    await user.click(keySave());
    await waitFor(() => {
      expect(shell.ai.settings().hasKey).toBe(true);
    });
    expect(await screen.findByText('A key is saved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Key')).toBeNull();
    // Testing is the next step for a new key.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Test key' })).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeEnabled();
    expect(screen.getByText('Stored in Windows Credential Manager, never in your library folder.')).toBeInTheDocument();
    await waitFor(() => {
      expect(announcedHere()).toBe('API key saved');
    });
    expectKeyNowhere(client, FAKE_KEY);
  });

  it('shows an invalid key under the field and keeps it to fix', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    const input = keyInput();
    await user.type(input, 'sk-test not-a-real-key');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(input).toHaveAccessibleDescription(/^This doesn't look like an API key\. Paste the whole key/);
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('sk-test not-a-real-key');
    expect(input).toHaveFocus();
    expect(shell.ai.settings().hasKey).toBe(false);
    expect(toastTexts()).toEqual([]);
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state))).not.toContain('not-a-real-key');
    // Typing clears the message.
    await user.type(input, 'x');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('says the key was not saved when the Windows confirmation is cancelled', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off', confirm: 'cancel' });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    expect(await screen.findByRole('heading', { name: 'API key' })).toBeInTheDocument();
    await user.type(keyInput(), FAKE_KEY);
    await user.click(keySave());
    const note = /^The key wasn't saved: you chose Cancel when Windows asked to allow this service\./;
    expect(await screen.findByText(note, { selector: '.settings-note' })).toBeInTheDocument();
    expect(announcedHere()).toMatch(note);
    expect(keyInput()).toHaveValue('');
    expect(keyInput()).toHaveFocus();
    expect(shell.ai.settings().hasKey).toBe(false);
    expectKeyNowhere(client, FAKE_KEY);
    // Typing again drops the note.
    await user.type(keyInput(), 'a');
    expect(screen.queryByText(note, { selector: '.settings-note' })).toBeNull();
  });

  it('removes the saved key and says so', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' });
    await user.click(await screen.findByRole('button', { name: 'Remove key' }));
    await waitFor(() => {
      expect(shell.ai.settings().hasKey).toBe(false);
    });
    await waitFor(() => {
      expect(keyInput()).toHaveFocus();
    });
    expect(screen.queryByText('A key is saved')).toBeNull();
    await waitFor(() => {
      expect(announcedHere()).toBe('API key removed');
    });
  });

  it('shows a banner when Windows Credential Manager fails, and drops the typed key', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' }, {
      scenario: 'ai-off',
      fail: [{ command: 'set_ai_key', code: 'AiCredential' }],
    });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    await user.type(keyInput(), FAKE_KEY);
    await user.click(keySave());
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't save the key");
    expect(banner).toHaveTextContent("Folio couldn't reach Windows Credential Manager for the API key.");
    expect(keyInput()).toHaveValue('');
    expect(keyInput()).not.toHaveAttribute('aria-invalid');
    // The pressed Save turned off with the emptied field: focus goes back to the field.
    await waitFor(() => {
      expect(keyInput()).toHaveFocus();
    });
    expect(shell.ai.settings().hasKey).toBe(false);
    expectKeyNowhere(client, FAKE_KEY);
  });

  it('says nothing when a save answers after the key card has gone', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    const saves = holdAnswers(shell, 'set_ai_key');
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    await user.type(keyInput(), FAKE_KEY);
    await user.keyboard('{Enter}');
    // The card goes before the answer comes.
    await chooseService(user, OTHER);
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    await saves.release();
    expect(shell.ai.settings().hasKey).toBe(true);
    expect(announcedHere()).toBe('');
    expect(toastTexts()).toEqual([]);
  });

  it('shows a toast when a save fails after the key card has gone', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, {
      scenario: 'ai-off',
      fail: [{ command: 'set_ai_key', code: 'AiCredential' }],
    });
    const saves = holdAnswers(shell, 'set_ai_key');
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    await user.type(keyInput(), FAKE_KEY);
    await user.keyboard('{Enter}');
    await chooseService(user, OTHER);
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    await saves.release();
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't save the key — "))).toBe(true);
    });
  });

  it('shows a toast when a removal fails after the key card has gone', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, {
      fail: [{ command: 'clear_ai_key', code: 'DataDirUnavailable' }],
    });
    const removals = holdAnswers(shell, 'clear_ai_key');
    await user.click(await screen.findByRole('button', { name: 'Remove key' }));
    expect(await screen.findByRole('button', { name: 'Removing…' })).toBeInTheDocument();
    await chooseService(user, OTHER);
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    await removals.release();
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't remove the key — "))).toBe(true);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(shell.ai.settings().hasKey).toBe(true);
  });

  it('shows a banner when the key cannot be removed', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, {
      fail: [{ command: 'clear_ai_key', code: 'DataDirUnavailable' }],
    });
    const remove = await screen.findByRole('button', { name: 'Remove key' });
    await user.click(remove);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't remove the key");
    expect(banner).toHaveTextContent("Folio can't find a place to keep its data.");
    expect(screen.getByText('A key is saved')).toBeInTheDocument();
    expect(remove).toHaveFocus();
    expect(shell.ai.settings().hasKey).toBe(true);
  });

  it('replaces a key, and Esc or Cancel goes back to the saved key', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' });
    await user.click(await screen.findByRole('button', { name: 'Replace key' }));
    await waitFor(() => {
      expect(keyInput('New key')).toHaveFocus();
    });
    expect(keyInput('New key')).toHaveAttribute('type', 'password');
    await user.type(keyInput('New key'), 'half-typed');
    await user.keyboard('{Escape}');
    // Esc ends the replacement, not the dialog.
    expect(settingsDialog('App settings')).toBeInTheDocument();
    expect(screen.getByText('A key is saved')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Replace key' })).toHaveFocus();
    });
    expect(pageState()).not.toContain('half-typed');

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(keyInput('New key')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('A key is saved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.type(keyInput('New key'), FAKE_KEY);
    await user.click(keySave('New key'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Test key' })).toHaveFocus();
    });
    await waitFor(() => {
      expect(announcedHere()).toBe('API key saved');
    });
    expect(shell.ai.settings().hasKey).toBe(true);
    expectKeyNowhere(client, FAKE_KEY);
  });

  it('drops a typed key when the dialog closes or the service changes', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    await user.type(keyInput(), FAKE_KEY);
    act(() => {
      shell.ai.update(TO_OTHER);
    });
    expect(await screen.findByRole('heading', { name: 'API key' })).toBeInTheDocument();
    expect(keyInput()).toHaveValue('');

    await user.type(keyInput(), FAKE_KEY);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'App settings' })).toBeNull();
    });
    expect(pageState()).not.toContain(FAKE_KEY);
    act(() => {
      openDialog('appSettings', { page: 'ai' });
    });
    await screen.findByRole('heading', { name: 'API key' });
    expect(keyInput()).toHaveValue('');
    expect(shell.ai.settings().hasKey).toBe(false);
  });

  it('asks for the address first while the other service is chosen and not saved', async () => {
    const { user, shell, client } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off' });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    await user.type(keyInput(), FAKE_KEY);
    await chooseService(user, OTHER);
    // The card is the chosen service's, and holds nothing that would act on DeepSeek's server.
    expect(screen.getByRole('heading', { name: 'API key' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'DeepSeek API key' })).toBeNull();
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    expect(screen.queryByLabelText('Key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test key' })).toBeNull();
    expect(screen.getByRole('switch', { name: AI_SWITCH })).toHaveAccessibleDescription(/the AI service writes one/);
    // The key typed for DeepSeek is dropped.
    expectKeyNowhere(client, FAKE_KEY);

    await user.type(screen.getByRole('textbox', { name: 'Address' }), OTHER_URL);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shell.ai.settings()).toMatchObject({ endpoint: OTHER_URL, hasKey: false });
    });
    expect(await screen.findByLabelText('Key')).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'API key' })).toBeInTheDocument();
    expect(screen.queryByText(ADDRESS_FIRST)).toBeNull();
  });

  it('hides the saved DeepSeek key while the other service is chosen, and shows it again on DeepSeek', async () => {
    const { user } = renderSettings('appSettings', { page: 'ai' });
    expect(await screen.findByText('A key is saved')).toBeInTheDocument();
    await chooseService(user, OTHER);
    expect(screen.getByText(ADDRESS_FIRST)).toBeInTheDocument();
    for (const name of ['Test key', 'Replace key', 'Remove key']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    await chooseService(user, 'DeepSeek');
    expect(screen.getByRole('heading', { name: 'DeepSeek API key' })).toBeInTheDocument();
    expect(screen.getByText('A key is saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeEnabled();
  });
});

const WORKS = 'DeepSeek answered. The key works.';
const ANY_WORKS = /answered\. The key works\./;

/** The status line that words a test's result, found by its text. */
async function testStatus(text: string | RegExp): Promise<HTMLElement> {
  const words = await screen.findByText(text);
  const status = words.closest('[role="status"]');
  if (!(status instanceof HTMLElement)) throw new Error('the result is not in a status line');
  return status;
}

describe('App settings → AI → testing the key', () => {
  it('says the key works when the service answers', async () => {
    const { user } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10 });
    const test = await screen.findByRole('button', { name: 'Test key' });
    await user.click(test);
    expect(await testStatus(WORKS)).toHaveClass('settings-card__status');
    expect(test).toHaveFocus();
    expect(toastTexts()).toEqual([]);
  });

  it.each([
    ['network', "DeepSeek didn't answer. Check your connection and try again."],
    ['timeout', 'DeepSeek took too long. Try again in a moment.'],
    ['rejected', 'DeepSeek turned down the API key. Check that you pasted the whole key, or replace it with a new one.'],
    ['rateLimited', 'DeepSeek is busy right now. Try again in a minute.'],
    ['unavailable', "DeepSeek isn't working right now. Try again later."],
    ['badResponse', "DeepSeek's answer couldn't be used. Check the model name and try again."],
    ['credential', "Folio couldn't read the API key from Windows Credential Manager. Replace the key, then test it again."],
  ] as const)('words the %s failure in the status line', async (aiMode, text) => {
    const { user } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10, aiMode });
    await user.click(await screen.findByRole('button', { name: 'Test key' }));
    await testStatus(text);
    // Nothing else changes: the key stays saved and nothing alerts.
    expect(screen.getByText('A key is saved')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['AiNotConfigured', /^No API key is saved for this service\. Save one, then test it\.$/],
    ['DataDirUnavailable', /^Couldn't test the key\. Folio can't find a place to keep its data\. Restart Folio\./],
  ] as const)('words a %s answer in the status line', async (code, text) => {
    const { user } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10, fail: [{ command: 'test_ai', code }] });
    await user.click(await screen.findByRole('button', { name: 'Test key' }));
    await testStatus(text);
  });

  it('names the AI service, and points at its address, for another endpoint', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10, aiMode: 'badResponse' });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    act(() => {
      shell.ai.update(TO_OTHER);
      shell.ai.setKey('fake-test-key-not-real');
    });
    expect(await screen.findByRole('heading', { name: 'API key' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Test key' }));
    await testStatus("The AI service's answer couldn't be used. Check the address and model name, then try again.");
    shell.ai.mode = 'network';
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await testStatus("The AI service didn't answer. Check your connection and try again.");
    shell.ai.mode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await testStatus('The AI service answered. The key works.');
  });

  it('shows Testing… while the service answers and keeps focus on the button', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10 });
    const tests = holdAnswers(shell, 'test_ai');
    const test = await screen.findByRole('button', { name: 'Test key' });
    // The status line is there, empty, before any test, so a screen reader reads each result.
    const status = within(screen.getByRole('region', { name: 'DeepSeek API key' })).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    await user.click(test);
    const pending = await screen.findByRole('button', { name: 'Testing…' });
    expect(pending).toHaveFocus();
    expect(status).toBeEmptyDOMElement();
    // The key cannot change under a running test.
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeDisabled();
    await tests.release();
    expect(await testStatus(WORKS)).toBe(status);
    expect(screen.getByRole('button', { name: 'Test key' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Remove key' })).toBeEnabled();
    // A second test empties the line first, so the same result is read again.
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByRole('button', { name: 'Testing…' });
    expect(status).toBeEmptyDOMElement();
    await tests.release();
    expect(await testStatus(WORKS)).toBe(status);
  });

  it('cannot test without a saved key', async () => {
    const { user } = renderSettings('appSettings', { page: 'ai' }, { scenario: 'ai-off', aiDelayMs: 10 });
    await screen.findByRole('heading', { name: 'DeepSeek API key' });
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
    await user.type(keyInput(), FAKE_KEY);
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
    await user.click(keySave());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Test key' })).toBeEnabled();
    });
  });

  it('clears the result when the key is removed, saved or being replaced', async () => {
    const { user, client } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10 });
    await user.click(await screen.findByRole('button', { name: 'Test key' }));
    await testStatus(WORKS);
    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() => {
      expect(keyInput()).toHaveFocus();
    });
    expect(screen.queryByText(WORKS)).toBeNull();
    await user.type(keyInput(), FAKE_KEY);
    await user.click(keySave());
    expect(await screen.findByText('A key is saved')).toBeInTheDocument();
    expect(screen.queryByText(WORKS)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await testStatus(WORKS);
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('A key is saved')).toBeInTheDocument();
    expect(screen.queryByText(WORKS)).toBeNull();
    expectKeyNowhere(client, FAKE_KEY);
  });

  it('clears the result when the key or the endpoint changes elsewhere', async () => {
    const { user, shell } = renderSettings('appSettings', { page: 'ai' }, { aiDelayMs: 10 });
    await user.click(await screen.findByRole('button', { name: 'Test key' }));
    await testStatus(WORKS);
    // Another address on DeepSeek's server keeps the key, but it is another endpoint.
    act(() => {
      shell.ai.update({ ...TO_OTHER, endpoint: `${DEFAULT_AI_ENDPOINT}/beta` });
    });
    expect(await screen.findByRole('heading', { name: 'API key' })).toBeInTheDocument();
    expect(shell.ai.settings().hasKey).toBe(true);
    expect(screen.queryByText(ANY_WORKS)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Test key' }));
    await testStatus('The AI service answered. The key works.');
    act(() => {
      shell.ai.clearKey();
    });
    await waitFor(() => {
      expect(screen.queryByText('A key is saved')).toBeNull();
    });
    act(() => {
      shell.ai.setKey('fake-test-key-not-real');
    });
    expect(await screen.findByText('A key is saved')).toBeInTheDocument();
    expect(screen.queryByText(ANY_WORKS)).toBeNull();
  });
});
