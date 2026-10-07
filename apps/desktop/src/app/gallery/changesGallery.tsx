// Dev server only (gallery.html is not a build input): the app on the fake shell, showing the
// Changes view, for design and accessibility reviews in the browser pane.
//
//   /gallery.html?view=changes&scenario=small|workspace-large|history-none|history-read-only|history-damaged|errors
//   &latency=<ms>  &fail=list_workspace_items:Internal  &theme=dark  &motion=on   as in the browser pane
//
// `__FOLIO_FAKE_SHELL__.editFile(path)`, `deleteFile(path)`, `addFile(path)` and
// `downloadFile(path)` in the console change the workspace.
import type { ReactElement } from 'react';

import { App } from '../../App';
import { createQueryClient } from '../../data/client';
import { DataProvider } from '../../data/DataProvider';
import { installFakeShell, optionsFromUrl } from '../../ipc/mock';
import { showView } from '../navigation';

/** Installs the fake shell from the page's URL and returns the app showing the Changes view. */
export function changesGallery(search: string): ReactElement {
  installFakeShell(optionsFromUrl(search));
  showView('changes');
  return (
    <DataProvider client={createQueryClient()}>
      <App />
    </DataProvider>
  );
}
