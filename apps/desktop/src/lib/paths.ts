// Library paths as the shell sends them: names separated by `/`, relative to the library root,
// compared exactly, case included (ipc-m1 §5.1; UI architecture §5.4).

/** The folder that holds `path`; `''` (the library root) for a top-level name. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The last name of `path`. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * `path` and the folders above it, nearest first, without its top-level folder (a semester): the
 * folders a tree opens to show what is in `path`.
 */
export function openPathsTo(path: string): string[] {
  const paths: string[] = [];
  for (let at = path; at.includes('/'); at = parentOf(at)) paths.push(at);
  return paths;
}

/** Whether `path` is `scope` or below it. `null` is the whole library. */
export function isInside(path: string, scope: string | null): boolean {
  return scope === null || path === scope || path.startsWith(`${scope}/`);
}

/** Whether `path` is strictly below `folder`; everything but the root is below the root `''`. */
export function isBelow(path: string, folder: string): boolean {
  return folder === '' ? path !== '' : path.startsWith(`${folder}/`);
}

/** `path` with the prefix `from` replaced by `to`, for references that follow a moved folder. */
export function movePath(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

/**
 * The absolute Windows path of a library path, for "Copy path": the root joined with the names
 * by `\` (library-actions handoff §6).
 */
export function windowsPath(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '');
  return path === '' ? base : `${base}\\${path.split('/').join('\\')}`;
}
