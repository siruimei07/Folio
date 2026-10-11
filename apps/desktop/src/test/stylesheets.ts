// Every stylesheet under src/, as raw text, for the tests that check what the stylesheets read: the
// token check (every property read is defined) and the guards that keep one drawing of a shared
// part in its component's stylesheet.

/** The stylesheets by their path from the package root (`/src/…/Name.css`). */
export const STYLESHEETS: Readonly<Record<string, string>> = import.meta.glob<string>('/src/**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The paths of the stylesheets that read any of the custom properties `names` with `var(`. */
export function stylesheetsReading(...names: readonly string[]): string[] {
  const wanted = new Set(names);
  return Object.entries(STYLESHEETS)
    .filter(([, text]) => [...text.matchAll(/var\(\s*(--[\w-]+)/g)].some((match) => wanted.has(match[1] ?? '')))
    .map(([file]) => file);
}
