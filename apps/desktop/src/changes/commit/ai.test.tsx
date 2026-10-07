// AI messages in the commit box (workspace-history handoff §4.2, §4.3) on the fake shell's AI
// service: Generate and what it writes, Stop and Esc, Ctrl+Z, each failure's warning note and its
// links, a commit with empty fields that waits for the AI and falls back to the template, AI off,
// and the name of a service other than DeepSeek.
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { closeDialog, useNavigation } from '../../app/navigation';
import { toastTexts } from '../../test/render';
import {
  callsOf,
  commitBox,
  committed,
  commitButton,
  commitRequests,
  CSC,
  descriptionField,
  findCommitNote,
  findRow,
  getRow,
  holdRequests,
  JOB_TEST,
  politeText,
  renderChanges,
  resizeTo,
  summaryField,
  TEMPLATE,
} from '../test/render';

/** What the fake service writes for the small workspace's included changes. */
const AI_SUMMARY = 'CSC148: update 10 files and their notes';
const AI_BODY = '- Tidy the lecture notes\n- Fix the review questions';
const KEEP = { enabled: null, endpoint: null, model: null, sendContent: null };

type AiMode = NonNullable<NonNullable<Parameters<typeof renderChanges>[0]>['aiMode']>;

/** The warning note whose title is `title`. */
async function findNote(title: string): Promise<HTMLElement> {
  const found = (await within(commitBox()).findByText(title)).closest<HTMLElement>('.banner');
  if (found === null) throw new Error('no note ' + title);
  return found;
}

/** The small workspace with the AI on, ready to commit. */
async function ready(options: Parameters<typeof renderChanges>[0] = {}) {
  const rendered = renderChanges({ aiDelayMs: 40, ...options });
  const invoke = vi.spyOn(rendered.shell, 'invoke');
  await findRow('CSC148/a1/run.bat');
  await waitFor(() => {
    expect(commitButton()).toHaveAccessibleName('Commit 14 changes');
  });
  return { ...rendered, invoke };
}

function messageButton(name: string): HTMLElement {
  return within(commitBox()).getByRole('button', { name });
}

/** The requests `cancel_ai_request` was sent. */
function cancelled(invoke: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'cancel_ai_request')
    .map(([, payload]) => (payload as { request: { requestId: string } }).request.requestId);
}

function generatedIds(invoke: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'generate_commit_message')
    .map(([, payload]) => (payload as { request: { requestId: string } }).request.requestId);
}

describe('Generate', JOB_TEST, () => {
  it('writes both fields while they are read-only, then says DeepSeek wrote them', async () => {
    const { user, invoke } = await ready({ aiMode: 'slow' });
    await user.type(summaryField(), 'Mine');
    await user.type(descriptionField(), 'Context for the AI.');
    await user.click(messageButton('Generate'));

    expect(within(commitBox()).getByRole('status')).toHaveTextContent('DeepSeek is writing…');
    expect(summaryField()).toHaveAttribute('readonly');
    expect(summaryField()).toHaveAttribute('aria-busy', 'true');
    expect(descriptionField()).toHaveAttribute('readonly');
    expect(commitBox().querySelectorAll('.commit-field__skeleton .skeleton__bar')).toHaveLength(4);
    // The same button now stops it, and keeps the focus; the options are gone.
    expect(messageButton('Stop')).toHaveFocus();
    expect(within(commitBox()).queryByRole('button', { name: 'Message options' })).toBeNull();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => {
      expect(generatedIds(invoke)).toHaveLength(1);
    });
    const sent = invoke.mock.calls.find(([command]) => command === 'generate_commit_message')?.[1] as {
      request: { description: string };
    };
    expect(sent.request.description).toBe('Context for the AI.');
  });

  it('fills the fields with the message, which Ctrl+Z takes back and an edit makes the person’s own', async () => {
    const { user } = await ready();
    await user.type(summaryField(), 'Mine');
    await user.click(messageButton('Generate'));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(AI_SUMMARY);
    });
    expect(descriptionField()).toHaveValue(AI_BODY);
    expect(within(commitBox()).getByText('Written by DeepSeek. Change anything you like.')).toBeInTheDocument();
    expect(messageButton('Generate')).toHaveFocus();
    // The status that said it was writing is gone: the result is said.
    expect(politeText()).toBe('Written by DeepSeek. Change anything you like.');

    act(() => {
      summaryField().focus();
    });
    await user.keyboard('{Control>}z{/Control}');
    expect(summaryField()).toHaveValue('Mine');
    expect(descriptionField()).toHaveValue('');
    expect(within(commitBox()).queryByText('Written by DeepSeek. Change anything you like.')).toBeNull();

    await user.click(messageButton('Generate'));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(AI_SUMMARY);
    });
    await user.type(descriptionField(), '!');
    expect(within(commitBox()).queryByText('Written by DeepSeek. Change anything you like.')).toBeNull();
    // Once edited, Ctrl+Z is the field's own again.
    act(() => {
      summaryField().focus();
    });
    await user.keyboard('{Control>}z{/Control}');
    expect(summaryField()).toHaveValue(AI_SUMMARY);
  });

  it('stops with Stop: the request is cancelled and the fields stay as they were', async () => {
    const { user, invoke } = await ready({ aiMode: 'slow' });
    await user.type(summaryField(), 'Mine');
    await user.click(messageButton('Generate'));
    await waitFor(() => {
      expect(generatedIds(invoke)).toHaveLength(1);
    });
    await user.click(messageButton('Stop'));
    expect(summaryField()).toHaveValue('Mine');
    expect(summaryField()).not.toHaveAttribute('readonly');
    expect(within(commitBox()).queryByRole('status')).toBeNull();
    await waitFor(() => {
      expect(cancelled(invoke)).toEqual(generatedIds(invoke));
    });
    expect(messageButton('Generate')).toHaveFocus();
    expect(commitButton()).not.toHaveAttribute('aria-disabled');
  });

  it('stops with Esc from a field', async () => {
    const { user, invoke } = await ready({ aiMode: 'slow' });
    await user.click(messageButton('Generate'));
    await waitFor(() => {
      expect(generatedIds(invoke)).toHaveLength(1);
    });
    act(() => {
      summaryField().focus();
    });
    await user.keyboard('{Escape}');
    expect(within(commitBox()).queryByRole('status')).toBeNull();
    await waitFor(() => {
      expect(cancelled(invoke)).toHaveLength(1);
    });
    expect(summaryField()).toHaveValue('');
  });

  it('is offered in the options menu, beside the template and AI settings', async () => {
    const { user } = await ready();
    await user.click(messageButton('Message options'));
    const menu = await screen.findByRole('menu', { name: 'Message options' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Write with DeepSeek',
      'Use the template',
      'AI settings…',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Write with DeepSeek' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(AI_SUMMARY);
    });
  });

  it('opens App settings on its AI page from the options menu', async () => {
    const { user } = await ready();
    await user.click(messageButton('Message options'));
    await user.click(await screen.findByRole('menuitem', { name: 'AI settings…' }));
    expect(useNavigation.getState().dialog).toEqual({ kind: 'appSettings', params: { page: 'ai' } });
    closeDialog();
  });
});

describe('when Generate fails', JOB_TEST, () => {
  const FAILURES: [AiMode, string, string, 'Try again' | 'AI settings'][] = [
    ['network', "DeepSeek didn't answer", 'Check your connection and try again. You can still commit: Folio writes a template message.', 'Try again'],
    ['timeout', 'DeepSeek took too long', 'Try again in a moment. You can still commit: Folio writes a template message.', 'Try again'],
    ['rejected', 'DeepSeek turned down the API key', 'Check the key in App settings → AI. You can still commit: Folio writes a template message.', 'AI settings'],
    ['rateLimited', 'DeepSeek is busy right now', 'Try again in a minute. You can still commit: Folio writes a template message.', 'Try again'],
    ['unavailable', "DeepSeek isn't working right now", 'Try again later. You can still commit: Folio writes a template message.', 'Try again'],
    ['badResponse', "DeepSeek's answer couldn't be used", 'Try again, or write the message yourself.', 'Try again'],
    ['credential', "Folio couldn't read the API key", "Windows Credential Manager didn't answer. Set the key again in App settings → AI.", 'AI settings'],
  ];

  it.each(FAILURES)('says why for %s, with its links, and leaves the fields alone', async (aiMode, title, text, link) => {
    const { user, shell, invoke } = await ready({ aiMode });
    await user.type(summaryField(), 'Mine');
    await user.click(messageButton('Generate'));
    const note = await findNote(title);
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent(`${title}${text}`);
    expect(summaryField()).toHaveValue('Mine');
    expect(within(note).getAllByRole('button').map((button) => button.textContent)).toEqual([link, 'Use template']);

    if (link === 'Try again') {
      shell.ai.mode = 'ok';
      await user.click(within(note).getByRole('button', { name: 'Try again' }));
      await waitFor(() => {
        expect(summaryField()).toHaveValue(AI_SUMMARY);
      });
      expect(generatedIds(invoke)).toHaveLength(2);
      // The note went with the link: the focus went to Generate's button (Stop while it wrote).
      expect(messageButton('Generate')).toHaveFocus();
    } else {
      await user.click(within(note).getByRole('button', { name: 'AI settings' }));
      expect(useNavigation.getState().dialog).toEqual({ kind: 'appSettings', params: { page: 'ai' } });
      closeDialog();
    }
  });

  it('writes the template from the note', async () => {
    const { user } = await ready({ aiMode: 'network' });
    await user.click(messageButton('Generate'));
    const note = await findNote("DeepSeek didn't answer");
    await user.click(within(note).getByRole('button', { name: 'Use template' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(TEMPLATE);
    });
    expect(within(commitBox()).queryByText("DeepSeek didn't answer")).toBeNull();
    // The note went with the link: the focus goes to the summary, where the template is.
    await waitFor(() => {
      expect(summaryField()).toHaveFocus();
    });
    expect(politeText()).toBe('Added the template message.');
  });
});

describe('a commit with both fields empty', JOB_TEST, () => {
  it('waits for the AI, then commits its message', async () => {
    const { user, invoke } = await ready({ aiDelayMs: 400 });
    await user.click(commitButton());
    expect(commitButton()).toHaveAccessibleName('Writing the message…');
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(within(commitBox()).getByRole('status')).toHaveTextContent('DeepSeek is writing…');
    expect(messageButton('Use template')).toBeInTheDocument();
    expect(within(commitBox()).queryByRole('group', { name: 'Message' })).toBeNull();
    expect(summaryField()).toHaveAttribute('readonly');
    await committed(`Committed 14 changes: ${AI_SUMMARY}`);
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: AI_SUMMARY, body: AI_BODY });
    expect(within(commitBox()).queryByRole('status')).toBeNull();
    expect(toastTexts()).toEqual([]);
  });

  it('commits the template at once with "Use template", without a word about the AI', async () => {
    const { user, invoke } = await ready({ aiMode: 'slow' });
    await user.click(commitButton());
    await waitFor(() => {
      expect(generatedIds(invoke)).toHaveLength(1);
    });
    await user.click(messageButton('Use template'));
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: TEMPLATE, body: null });
    expect(cancelled(invoke)).toEqual(generatedIds(invoke));
    // The link went as the commit went on: the focus is on the commit button (§4.4).
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
    await committed(`Committed 14 changes: ${TEMPLATE}`);
    expect(toastTexts()).toEqual([]);
  });

  it('commits the template with "Use template" pressed before the selection was summarized, never asking the AI', async () => {
    const { user, shell, invoke } = await ready();
    // The selection's summary under the next fingerprint waits until the template was chosen.
    const { release } = holdRequests(shell, (command) => command === 'summarize_selection');
    const asked = callsOf(invoke, 'summarize_selection');
    act(() => {
      shell.editFile(`${CSC}/a1/run.bat`);
    });
    await waitFor(() => {
      expect(callsOf(invoke, 'summarize_selection')).toBeGreaterThan(asked);
    });
    await user.click(commitButton());
    expect(commitButton()).toHaveAccessibleName('Writing the message…');
    await user.click(messageButton('Use template'));
    act(() => {
      release();
    });
    await committed(`Committed 14 changes: ${TEMPLATE}`);
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: TEMPLATE, body: null });
    expect(generatedIds(invoke)).toEqual([]);
    // Nothing to cancel: no request was sent.
    expect(cancelled(invoke)).toEqual([]);
  });

  it('keeps the focus on the commit button when Ctrl+Enter from Generate starts a commit that hides it', async () => {
    const { user } = await ready({ aiMode: 'slow' });
    act(() => {
      messageButton('Generate').focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(commitButton()).toHaveAccessibleName('Writing the message…');
    expect(within(commitBox()).queryByRole('group', { name: 'Message' })).toBeNull();
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });

  it('commits the template when the AI fails, and says so with the reason', async () => {
    const { user, invoke } = await ready({ aiMode: 'network' });
    await user.click(commitButton());
    await committed(`Committed 14 changes: ${TEMPLATE}`);
    expect(toastTexts()).toEqual([
      `Committed with a template message — DeepSeek didn't answer, so the message is “${TEMPLATE}”. You can edit it until you sync.`,
    ]);
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: TEMPLATE });
    // No warning note: the commit went on.
    expect(within(commitBox()).queryByText("DeepSeek didn't answer")).toBeNull();
  });

  it('says why the commit failed when the workspace changed while the AI wrote', async () => {
    const { user, shell } = await ready({ aiDelayMs: 300 });
    await user.click(commitButton());
    expect(commitButton()).toHaveAccessibleName('Writing the message…');
    act(() => {
      shell.editFile(`Fall 2026/CSC148 Introduction to Computer Science/a1/run.bat`);
      shell.addFile('Fall 2026/CSC148 Introduction to Computer Science/a1/new.py');
    });
    expect(await findCommitNote()).toHaveTextContent(
      "Couldn't commitThe changes changed while you were committing. Check the list, then commit again.",
    );
  });
});

describe('with the AI off', JOB_TEST, () => {
  it('words everything without the AI and commits the template at once', async () => {
    const { user, invoke } = await ready({ scenario: 'ai-off' });
    expect(within(commitBox()).queryByRole('button', { name: 'Generate' })).toBeNull();
    expect(messageButton('Use template')).toBeInTheDocument();
    expect(descriptionField()).toHaveAttribute('placeholder', 'Description (optional). Leave both empty and Folio writes a short summary.');
    expect(commitBox()).not.toHaveTextContent(/DeepSeek/);
    await user.click(messageButton('Message options'));
    const menu = await screen.findByRole('menu', { name: 'Message options' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Use the template', 'AI settings…']);
    await user.keyboard('{Escape}');

    await user.click(commitButton());
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(callsOf(invoke, 'generate_commit_message')).toBe(0);
    expect(toastTexts()).toEqual([]);
  });

  it('writes the template when the AI turned off after Generate was offered', async () => {
    const { user, shell } = await ready();
    act(() => {
      shell.ai.clearKey();
    });
    await waitFor(() => {
      expect(messageButton('Use template')).toBeInTheDocument();
    });
    expect(descriptionField()).toHaveAttribute('placeholder', 'Description (optional). Leave both empty and Folio writes a short summary.');
    await user.click(messageButton('Use template'));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(TEMPLATE);
    });
  });
});

describe('another AI service', JOB_TEST, () => {
  it('is named "the AI service"', async () => {
    const { user, shell } = await ready({ aiMode: 'network' });
    act(() => {
      shell.ai.update({ ...KEEP, endpoint: 'https://ai.example.test/v1' });
      shell.ai.setKey('sk-other');
    });
    await waitFor(() => {
      expect(descriptionField()).toHaveAttribute('placeholder', 'Description (optional). Leave both empty and the AI service writes them.');
    });
    await user.click(messageButton('Message options'));
    expect(await screen.findByRole('menuitem', { name: 'Write with the AI service' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    shell.ai.mode = 'slow';
    await user.click(messageButton('Generate'));
    expect(within(commitBox()).getByRole('status')).toHaveTextContent('The AI service is writing…');
    await user.click(messageButton('Stop'));
    shell.ai.mode = 'network';
    await user.click(messageButton('Generate'));
    expect(await within(commitBox()).findByText("The AI service didn't answer")).toBeInTheDocument();
    expect(commitBox()).not.toHaveTextContent(/DeepSeek/);
  });
});

describe('the narrow commit bar', JOB_TEST, () => {
  beforeEach(() => {
    resizeTo(680);
  });
  afterEach(() => {
    resizeTo(1024);
  });

  it('generates from its icon button, which stops it, with the status between the rows', async () => {
    const { user } = await ready({ aiMode: 'slow' });
    await user.click(messageButton('Generate a message'));
    expect(messageButton('Stop')).toHaveFocus();
    const status = within(commitBox()).getByRole('status');
    expect(status).toHaveTextContent('DeepSeek is writing…');
    const parts = [...commitBox().children];
    const at = parts.findIndex((part) => part.contains(status));
    expect(at).toBeGreaterThan(parts.findIndex((part) => part.classList.contains('commit-bar__row')));
    expect(at).toBeLessThan(parts.findIndex((part) => part.classList.contains('commit-button')));
    await user.click(messageButton('Stop'));
    expect(messageButton('Generate a message')).toHaveFocus();
  });

  it('opens the description while Generate writes it, so what it wrote is seen before a commit', async () => {
    const { user, shell } = await ready({ aiMode: 'slow' });
    const description = commitBox().querySelector('.commit-bar__description');
    const toggle = () => {
      const found = commitBox().querySelector<HTMLElement>('button[aria-expanded]');
      if (found === null) throw new Error('no description toggle');
      return found;
    };
    expect(description).not.toHaveAttribute('data-open');
    expect(toggle()).toHaveAccessibleName('Add a description');
    // Generate starts: the description opens with its skeleton bars.
    await user.click(messageButton('Generate a message'));
    expect(description).toHaveAttribute('data-open');
    expect(description?.querySelectorAll('.skeleton__bar')).toHaveLength(3);
    expect(toggle()).toHaveAccessibleName('Hide the description');
    // Closed while it writes, it opens again with what it wrote.
    await user.click(toggle());
    expect(description).not.toHaveAttribute('data-open');
    await user.click(messageButton('Stop'));
    shell.ai.mode = 'ok';
    const { release } = holdRequests(shell, (command) => command === 'generate_commit_message');
    await user.click(messageButton('Generate a message'));
    await user.click(toggle());
    expect(description).not.toHaveAttribute('data-open');
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(descriptionField()).toHaveValue(AI_BODY);
    });
    expect(description).toHaveAttribute('data-open');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    // Closed by the person with text in it: the toggle says there is a description to show.
    await user.click(toggle());
    expect(toggle()).toHaveAccessibleName('Show the description');
    // Ctrl+Z in the summary puts the text before back, an empty description: it stays closed.
    await user.click(summaryField());
    await user.keyboard('{Control>}z{/Control}');
    expect(descriptionField()).toHaveValue('');
    expect(toggle()).toHaveAccessibleName('Add a description');
  });

  it("leaves the description over the list closed when Generate's message comes after the focus went to a row", async () => {
    const { user, shell } = await ready();
    const tall = window.innerHeight;
    onTestFinished(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    act(() => {
      window.innerWidth = 500;
      window.innerHeight = 320;
      window.dispatchEvent(new Event('resize'));
    });
    const description = commitBox().querySelector('.commit-bar__description');
    expect(description).toHaveAttribute('data-over');
    const { release } = holdRequests(shell, (command) => command === 'generate_commit_message');
    await user.click(messageButton('Generate a message'));
    expect(description).toHaveAttribute('data-open');
    // The person goes on in the list while it writes (a click opens the diff, Esc goes back to the
    // row): the description over the list closes.
    await user.click(getRow('CSC148/labs/lab1/report.docx'));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    });
    expect(description).not.toHaveAttribute('data-open');
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(descriptionField()).toHaveValue(AI_BODY);
    });
    // What it wrote does not open it over the focused row; the toggle says there is one to show.
    expect(description).not.toHaveAttribute('data-open');
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveFocus();
    expect(within(commitBox()).getByRole('button', { name: 'Show the description' })).toHaveAttribute('aria-expanded', 'false');
    // From the bar, the next fill opens it: Ctrl+Z in the summary brings back the empty text, and
    // Generate writes it again.
    await user.click(summaryField());
    await user.keyboard('{Control>}z{/Control}');
    expect(descriptionField()).toHaveValue('');
    await user.click(messageButton('Generate a message'));
    await waitFor(() => {
      expect(descriptionField()).toHaveValue(AI_BODY);
    });
    expect(description).toHaveAttribute('data-open');
  });

  it('says why the commit button waits while Generate writes, without a shortcut that does nothing', async () => {
    const { user } = await ready({ aiMode: 'slow' });
    expect(commitButton()).toHaveAccessibleDescription('Ctrl+Enter');
    await user.click(messageButton('Generate a message'));
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton()).toHaveAccessibleDescription('DeepSeek is writing…');
    expect(commitButton()).not.toHaveTextContent('Ctrl+Enter');
  });

  // The bar keeps its focus as the box does when the control that had it goes (useCommitBoxFocus).
  it('keeps the focus on the commit button when the waiting status\'s "Use template" goes', async () => {
    const { user, invoke } = await ready({ aiMode: 'slow' });
    expect(commitBox()).toHaveClass('commit-bar');
    await user.click(commitButton());
    await waitFor(() => {
      expect(generatedIds(invoke)).toHaveLength(1);
    });
    await user.click(messageButton('Use template'));
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });

  it('puts the focus on the summary when the note\'s "Use template" writes the template there', async () => {
    const { user } = await ready({ aiMode: 'network' });
    await user.click(messageButton('Generate a message'));
    const note = await findNote("DeepSeek didn't answer");
    await user.click(within(note).getByRole('button', { name: 'Use template' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(TEMPLATE);
    });
    await waitFor(() => {
      expect(summaryField()).toHaveFocus();
    });
  });

  it('puts the focus on the message button when the note\'s "Try again" goes', async () => {
    const { user, shell } = await ready({ aiMode: 'network' });
    await user.click(messageButton('Generate a message'));
    const note = await findNote("DeepSeek didn't answer");
    shell.ai.mode = 'ok';
    await user.click(within(note).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(AI_SUMMARY);
    });
    expect(messageButton('Generate a message')).toHaveFocus();
  });
});
