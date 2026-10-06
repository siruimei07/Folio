// Dev server only (gallery.html is not a build input): the window shell and the shared components
// in every state, for design and accessibility reviews in the browser pane.
//
//   /gallery.html                      the shell with sample toolbar controls and dialogs
//   /gallery.html?view=components      every shared component and state
//   /gallery.html?view=diff            the diff pane on the fake shell (diffGallery.tsx)
//   &theme=light|dark  &motion=on|off  &activity=running|several|done|problems|hidden
//   &fail=minimize|maximize|close|drag|background   the window command fails

import '../../base.css';

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../../App';
import { initI18n } from '../../i18n';
import { applyAppearance } from '../appearance';
import { watchLayout } from '../layout';
import { ComponentsGallery } from './ComponentsGallery';
import { diffGallery } from './diffGallery';
import { galleryRegistry } from './registry';

await initI18n();

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme');
const motion = params.get('motion');
applyAppearance({
  theme: theme === 'light' || theme === 'dark' ? theme : 'system',
  reduceMotion: motion === 'on' || motion === 'off' ? motion : 'system',
});
watchLayout();

const WINDOW_COMMANDS: Record<string, string> = {
  minimize: 'plugin:window|minimize',
  maximize: 'plugin:window|toggle_maximize',
  close: 'plugin:window|close',
  drag: 'plugin:window|start_dragging',
  background: 'plugin:window|is_maximized',
};
const failing = WINDOW_COMMANDS[params.get('fail') ?? ''];

mockWindows('main');
mockIPC(
  (command) => {
    if (command === failing) throw new Error(`${command} not allowed (gallery)`);
    if (command === 'app_info') return { appVersion: '0.1.0', coreVersion: '0.1.0', dataDir: 'C:\\Users\\sirui\\AppData\\Local\\Folio' };
    if (command === 'plugin:window|is_maximized') return false;
    return null;
  },
  { shouldMockEvents: true },
);

const container = document.getElementById('root');
if (!container) throw new Error('gallery.html must contain an element with id "root"');

function galleryView(view: string | null) {
  if (view === 'components') return <ComponentsGallery />;
  // Replaces the stand-in IPC above with the fake shell.
  if (view === 'diff') return diffGallery(window.location.search);
  return <App registry={galleryRegistry(params.get('activity'))} deviceName="G16" />;
}

createRoot(container).render(<StrictMode>{galleryView(params.get('view'))}</StrictMode>);
