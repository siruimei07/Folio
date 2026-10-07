// The app's file actions (library-actions handoff §6, §9.3): opening with the default app, showing
// in File Explorer and copying paths, with their toasts, on the fake shell.
import { act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useCourses } from '../data/groups';
import { NOW, smallRef } from '../test/data';
import { renderAppHook, toastTexts } from '../test/render';
import { useFileActions } from './fileActions';
import { useToasts } from './toasts';

const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const ROOT = 'E:\\University of Toronto';

/** The actions once the courses, which name a course in messages, have loaded. */
async function renderActions() {
  useToasts.setState({ toasts: [] });
  const rendered = renderAppHook(() => ({ actions: useFileActions(), courses: useCourses().data }), {
    scenario: 'small',
    now: NOW,
  });
  await waitFor(() => {
    expect(rendered.result.current.courses).toBeDefined();
  });
  const result = {
    get current() {
      return rendered.result.current.actions;
    },
  };
  return { result, shell: rendered.shell, invoke: vi.spyOn(rendered.shell, 'invoke') };
}

/** The commands the fake shell was sent, by name. */
function sent(invoke: Awaited<ReturnType<typeof renderActions>>['invoke'], command: string): unknown[] {
  return invoke.mock.calls.filter(([name]) => name === command).map(([, payload]) => payload);
}

function toastActions(): string[] {
  return useToasts.getState().toasts.flatMap((toast) => (toast.actions ?? []).map((action) => action.label));
}

describe('open', () => {
  it('opens a file without a word, and a script in its editor with a toast that says why', async () => {
    const { result, invoke } = await renderActions();
    act(() => {
      result.current.open(smallRef(`${MAT}/week 2 notes.md`));
    });
    await waitFor(() => {
      expect(sent(invoke, 'open_entry')).toHaveLength(1);
    });
    expect(toastTexts()).toEqual([]);

    act(() => {
      result.current.open(smallRef(`${CSC}/a1/run.bat`));
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Opened run.bat in an editor — Folio doesn't run programs or scripts, so it opened this one for editing.",
      ]);
    });
  });

  it('says a program stays closed, and offers to show it in File Explorer', async () => {
    const { result, shell, invoke } = await renderActions();
    shell.setFailure('open_entry', 'Blocked');
    const entry = smallRef(`${CSC}/a1/run.bat`);
    act(() => {
      result.current.open(entry);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Folio doesn't open programs — To keep you safe, it won't run run.bat. Show it in File Explorer if you want to open it yourself.",
      ]);
    });
    expect(useToasts.getState().toasts[0]?.tone).toBe('warning');
    expect(toastActions()).toEqual(['Show in File Explorer']);
    act(() => {
      useToasts.getState().toasts[0]?.actions?.[0]?.onPress();
    });
    await waitFor(() => {
      expect(sent(invoke, 'reveal_entry')).toEqual([{ request: { entry } }]);
    });
  });

  it('names what failed to open, a course by its code, with Copy details for a file system error', async () => {
    const { result, shell } = await renderActions();
    shell.setFailure('open_entry', 'FileSystem');
    act(() => {
      result.current.open(smallRef(MAT));
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringMatching(/^Couldn't open MAT232 — /)]);
    });
    expect(useToasts.getState().toasts[0]?.tone).toBe('danger');
    expect(toastActions()).toEqual(['Copy details']);
  });

  it('says the file is not there any more when it went', async () => {
    const { result, shell } = await renderActions();
    shell.setFailure('open_entry', 'NotFound');
    act(() => {
      result.current.open(smallRef(`${MAT}/week 2 notes.md`));
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(["This item isn't here anymore. It may have just been moved, renamed or deleted."]);
    });
  });
});

describe('show in File Explorer', () => {
  it('asks the shell to show the entry, and names it when that fails', async () => {
    const { result, shell, invoke } = await renderActions();
    const entry = smallRef(`${MAT}/week 2 notes.md`);
    act(() => {
      result.current.showInExplorer(entry);
    });
    await waitFor(() => {
      expect(sent(invoke, 'reveal_entry')).toEqual([{ request: { entry } }]);
    });
    expect(toastTexts()).toEqual([]);

    shell.setFailure('reveal_entry', 'AccessDenied');
    act(() => {
      result.current.showInExplorer(entry);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringMatching(/^Couldn't show week 2 notes\.md in File Explorer — /)]);
    });
    expect(toastActions()).toEqual([]);
  });
});

describe('show a folder in File Explorer by its path', () => {
  it('finds the folder and asks the shell to show it', async () => {
    const { result, invoke } = await renderActions();
    act(() => {
      result.current.showFolderInExplorer('Personal/Photos');
    });
    await waitFor(() => {
      expect(sent(invoke, 'reveal_entry')).toEqual([{ request: { entry: smallRef('Personal/Photos') } }]);
    });

    act(() => {
      result.current.showFolderInExplorer(`${MAT}/Exams/Midterm`);
    });
    await waitFor(() => {
      expect(sent(invoke, 'reveal_entry')).toHaveLength(2);
    });
    expect(sent(invoke, 'reveal_entry')[1]).toEqual({ request: { entry: smallRef(`${MAT}/Exams/Midterm`) } });
    expect(toastTexts()).toEqual([]);
  });

  it('says the folder is not there for a missing path, a file or another case, and shows nothing', async () => {
    const { result, invoke } = await renderActions();
    for (const path of ['Personal/Videos', 'Personal/Todo.txt', 'personal/photos']) {
      useToasts.setState({ toasts: [] });
      act(() => {
        result.current.showFolderInExplorer(path);
      });
      await waitFor(() => {
        expect(toastTexts()).toEqual(["This item isn't here anymore. It may have just been moved, renamed or deleted."]);
      });
      expect(useToasts.getState().toasts[0]?.tone).toBe('info');
    }
    expect(sent(invoke, 'reveal_entry')).toEqual([]);
  });

  it('names the folder as a place when a read fails, with Copy details for an internal error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, shell, invoke } = await renderActions();
    shell.setFailure('list_children', 'Internal');
    act(() => {
      result.current.showFolderInExplorer(`${MAT}/Problem sets`);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringMatching(/^Couldn't show MAT232 \/ Problem sets in File Explorer — /)]);
    });
    expect(useToasts.getState().toasts[0]?.tone).toBe('danger');
    expect(toastActions()).toEqual(['Copy details']);
    expect(sent(invoke, 'reveal_entry')).toEqual([]);
    expect(error).toHaveBeenCalledWith('[command] file.reveal', expect.objectContaining({ code: 'Internal' }));
  });

  it('names the folder when File Explorer cannot show it, a course by its label', async () => {
    const { result, shell } = await renderActions();
    shell.setFailure('reveal_entry', 'AccessDenied');
    act(() => {
      // A folder in a semester is a course; Photos has no code.
      result.current.showFolderInExplorer('Personal/Photos');
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringMatching(/^Couldn't show Photos in File Explorer — /)]);
    });
    expect(toastActions()).toEqual([]);
  });
});

describe('copy path', () => {
  it('copies absolute Windows paths, one per line, and says so', async () => {
    userEvent.setup();
    const { result } = await renderActions();
    act(() => {
      result.current.copyPaths([`${CSC}/a1/run.bat`]);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied the path']);
    });
    expect(await navigator.clipboard.readText()).toBe(`${ROOT}\\Fall 2026\\CSC148 Introduction to Computer Science\\a1\\run.bat`);

    act(() => {
      result.current.copyPaths(['Deleted file.txt', `${MAT}/week 2 notes.md`]);
    });
    await waitFor(() => {
      expect(toastTexts()).toContain('Copied 2 paths');
    });
    expect(await navigator.clipboard.readText()).toBe(
      `${ROOT}\\Deleted file.txt\n${ROOT}\\Fall 2026\\MAT232 Calculus of Several Variables\\week 2 notes.md`,
    );
  });

  it('says when the clipboard refuses the path', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = await renderActions();
    act(() => {
      result.current.copyPaths([`${CSC}/a1/run.bat`]);
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(["Couldn't copy the path"]);
    });
    expect(useToasts.getState().toasts[0]?.tone).toBe('danger');
    expect(error).toHaveBeenCalledWith('copying to the clipboard failed', expect.any(Error));
  });
});
