// Import tests against the fake shell: the dialogs as the shell hosts them, the toasts, a stand-in
// for the Library's folder picker, and the small fixture at a fixed time, where CSC148 already has
// hw3.py (a name the sample import clashes with).
import { act } from '@testing-library/react';

import { ImportToasts } from '../../app/activity/ImportToasts';
import { resetJobNotes } from '../../app/activity/notes';
import { DialogHost } from '../../app/DialogHost';
import { closeDialog, HostedDialogs, openDialog } from '../../app/navigation';
import { ToastRegion } from '../../app/ToastRegion';
import { useToasts } from '../../app/toasts';
import type { EntryRef, ImportSource } from '../../ipc';
import { NOW } from '../../test/data';
import { renderApp, type RenderAppOptions } from '../../test/render';
import { type FolderPickerProps, importDialog, ImportResultDialog } from '..';

export const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
export const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';

/** Folders the stand-in picker offers. */
let places: readonly EntryRef[] = [];

/** The folder picker's stand-in: a button per place. */
function StubPicker({ onChoose }: FolderPickerProps) {
  return (
    <ul>
      {places.map((place) => (
        <li key={place.id}>
          <button
            type="button"
            onClick={() => {
              onChoose(place);
            }}
          >
            {`Pick ${place.path}`}
          </button>
        </li>
      ))}
    </ul>
  );
}

type Shell = ReturnType<typeof renderApp>['shell'];
export type ImportScript = NonNullable<Parameters<Shell['pickImport']>[0]>;

/** A file at the top of a source. */
export function file(path: string, size = '1000'): ImportScript['items'][number] {
  return { path, kind: 'file', size };
}

export function renderImport(options: RenderAppOptions = {}) {
  closeDialog();
  resetJobNotes();
  useToasts.setState({ toasts: [] });
  const view = renderApp(
    <HostedDialogs value={new Set(['import', 'importResult'])}>
      <DialogHost dialogs={{ import: importDialog(StubPicker), importResult: ImportResultDialog }} />
      <ImportToasts />
      <ToastRegion />
    </HostedDialogs>,
    { now: NOW, ...options },
  );
  const { shell } = view;
  const refAt = (path: string): EntryRef => {
    const node = shell.library.at(path);
    if (node === undefined) throw new Error(`No ${path} in the fixture`);
    return shell.library.ref(node);
  };
  places = [refAt(CSC), refAt(MAT)];

  /** Opens the dialog as "Add files" or a drop would, for the sample import or `script`. */
  const open = (target: EntryRef | null = refAt(CSC), { script, tags }: { script?: ImportScript; tags?: string[] } = {}) => {
    const picked = shell.pickImport(script);
    if (picked === null) throw new Error('The file dialog was cancelled');
    const top = picked.script.items.filter((item) => !item.path.includes('/'));
    const source: ImportSource = {
      token: picked.token,
      files: top.filter((item) => item.kind === 'file').length,
      folders: top.filter((item) => item.kind === 'folder').length,
      names: picked.script.names,
    };
    act(() => {
      openDialog('import', { source, target, tags });
    });
    return source;
  };
  return { ...view, refAt, open };
}
