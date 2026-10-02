// Settings dialogs as the shell hosts them, against the fake shell, with the live regions they
// announce in and the toasts they show.
import { act, screen } from '@testing-library/react';

import { Announcer } from '../../app/announcer';
import { DialogHost } from '../../app/DialogHost';
import { type DialogParams, openDialog, useNavigation } from '../../app/navigation';
import { useToasts } from '../../app/toasts';
import { NOW } from '../../test/data';
import { renderApp, type RenderAppOptions } from '../../test/render';
import { AddCoursesDialog, AppSettings, LibrarySettings, NewSemesterDialog } from '..';

type Hosted = 'librarySettings' | 'appSettings' | 'newSemester' | 'addCourses';

/** Opens the dialog `kind` with `params`, hosted with the other settings dialogs. */
export function renderSettings<K extends Hosted>(kind: K, params: DialogParams[K], options: RenderAppOptions = {}) {
  useNavigation.setState({ dialog: null, view: 'library', revealTarget: null });
  useToasts.setState({ toasts: [] });
  const rendered = renderApp(
    <>
      <Announcer />
      <DialogHost
        dialogs={{
          librarySettings: LibrarySettings,
          appSettings: AppSettings,
          newSemester: NewSemesterDialog,
          addCourses: AddCoursesDialog,
        }}
      />
    </>,
    { now: NOW, ...options },
  );
  act(() => {
    // Each kind takes its own parameters; `K` ties them together for the caller.
    (openDialog as (kind: Hosted, params: DialogParams[K]) => void)(kind, params);
  });
  return rendered;
}

/** The text of the polite live region. */
export function announced(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? '';
}

/** The settings dialog on screen. */
export function settingsDialog(name: 'Library settings' | 'App settings'): HTMLElement {
  return screen.getByRole('dialog', { name });
}
