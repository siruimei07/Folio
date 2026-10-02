// What a page shows when `create_library` or `open_library` fails (first-run handoff §4.4): a
// banner above step 1's footer, or under the unavailable screen's folder, and step 1's footer
// buttons. The name codes go under the name field instead (§8), so they are not here.
import { useTranslation } from 'react-i18next';

import type { Tone } from '../components/feedback';
import type { IpcError } from '../ipc';
import { driveOf, isLibraryNameCode, type LibraryNameCode } from './names';

/** A button of step 1's footer; the last one is the accent button and takes focus. */
export type StepAction = 'back' | 'tryAgain' | 'chooseAnother' | 'chooseFolder' | 'copyDetails' | 'useAnyway' | 'submit';

/** The actions that run the step's command, and show its spinner while it runs. */
export const COMMAND_ACTIONS: ReadonlySet<StepAction> = new Set(['submit', 'useAnyway', 'tryAgain']);

export interface StepFooter {
  /** On the left. */
  start: StepAction[];
  /** On the right; the last is the accent button. */
  end: StepAction[];
}

/** Keys of the `first-run` namespace for each banner. */
type FailureBanner = 'alreadyALibrary' | 'accessDenied' | 'choiceExpired' | 'notALibrary' | 'newerFormat' | 'diskFull' | 'failed';

export interface StepFailure {
  tone: Tone;
  footer: StepFooter;
  title: string;
  text: string;
}

/** The library name's own codes, shown under its field. */
export function isNameFailure(error: IpcError): error is IpcError & { code: LibraryNameCode } {
  return isLibraryNameCode(error.code);
}

/**
 * The banner of each failure (§4.4, rows 3–9) and step 1's footer with it. Rows 8 and 9 also keep
 * Back on the left, so a failure that repeats never leaves the user without a way out.
 */
function bannerOf(error: IpcError): { banner: FailureBanner; tone: Tone; footer: StepFooter } {
  switch (error.code) {
    case 'AlreadyALibrary':
      return { banner: 'alreadyALibrary', tone: 'danger', footer: { start: [], end: ['chooseAnother'] } };
    case 'AccessDenied':
      return { banner: 'accessDenied', tone: 'danger', footer: { start: [], end: ['tryAgain', 'chooseAnother'] } };
    case 'ChoiceExpired':
      return { banner: 'choiceExpired', tone: 'warning', footer: { start: [], end: ['chooseFolder'] } };
    case 'NotALibrary':
      return { banner: 'notALibrary', tone: 'danger', footer: { start: ['back'], end: ['chooseAnother'] } };
    case 'NewerFormat':
      return { banner: 'newerFormat', tone: 'danger', footer: { start: [], end: ['chooseAnother'] } };
    case 'DiskFull':
      return { banner: 'diskFull', tone: 'danger', footer: { start: ['back'], end: ['tryAgain'] } };
    default:
      return { banner: 'failed', tone: 'danger', footer: { start: ['back'], end: ['copyDetails', 'tryAgain'] } };
  }
}

/**
 * Words a failure of a library command: the banner's title and text, in its tone, and step 1's
 * footer. `path` is the chosen folder, whose drive a full disk names.
 */
export function useStepFailure(): (error: IpcError, path: string | null) => StepFailure {
  const { t } = useTranslation('first-run');
  return (error, path) => {
    const { banner, tone, footer } = bannerOf(error);
    const drive = path === null ? null : driveOf(path);
    const text =
      banner === 'diskFull'
        ? drive === null
          ? t('errors.diskFull.textNoDrive')
          : t('errors.diskFull.text', { drive })
        : t(`errors.${banner}.text`);
    return { tone, footer, title: t(`errors.${banner}.title`), text };
  };
}
