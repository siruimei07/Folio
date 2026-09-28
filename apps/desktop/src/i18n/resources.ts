import changes from './locales/en/changes.json';
import common from './locales/en/common.json';
import conflicts from './locales/en/conflicts.json';
import diff from './locales/en/diff.json';
import errors from './locales/en/errors.json';
import firstRun from './locales/en/first-run.json';
import history from './locales/en/history.json';
import importFiles from './locales/en/import.json';
import library from './locales/en/library.json';
import preview from './locales/en/preview.json';
import remoteSetup from './locales/en/remote-setup.json';
import search from './locales/en/search.json';
import settings from './locales/en/settings.json';
import shell from './locales/en/shell.json';
import sync from './locales/en/sync.json';
import titlebar from './locales/en/titlebar.json';

/**
 * The UI strings, one namespace per view (README.md). Every view on the roadmap has its namespace
 * already, so parallel lanes add strings to different files and leave this list alone.
 */
export const en = {
  common,
  errors,
  titlebar,
  shell,
  library,
  search,
  preview,
  import: importFiles,
  settings,
  'first-run': firstRun,
  diff,
  changes,
  history,
  sync,
  conflicts,
  'remote-setup': remoteSetup,
};

/** Where `t()` looks up a key that names no namespace. */
export const defaultNS = 'common';
