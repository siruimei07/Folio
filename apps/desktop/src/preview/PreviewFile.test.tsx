// A file's preview without its header (`PREVIEW_FILE`) on the fake shell: a stored version's bytes
// come from the version route, "Open with default app" opens the file the version belongs to now
// or is not offered, and a version has no thumbnail. Files in the library are covered through the
// pane (PreviewPane.test.tsx).
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewFileSource } from '../app/panes';
import { contentUrl, versionUrl } from '../ipc';
import { nameOf } from '../lib/paths';
import { NOW } from '../test/data';
import { fakeShell as fake, frameMessages, refOf, serveFiles, type ServedBody } from '../test/files';
import { smallLibraryWith } from '../test/fixtures';
import { renderApp } from '../test/render';
import { PreviewFile } from './PreviewFile';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const LINEAR = 'Fall 2026/线性代数';
const WEEK2 = `${MAT}/week 2 notes.md`;
/** Committed here; moved into "Problem sets/" in the workspace since. */
const PS2 = `${MAT}/ps2 solutions.md`;
/** Committed in "Exercises/"; the workspace moved the folder to "习题/". */
const EXERCISE = `${LINEAR}/Exercises/习题 1.docx`;
const PAGE = { offset: 0, limit: 500 };

/** The oldest version a commit stored at `path`, as a preview source. */
function stored(path: string): Extract<PreviewFileSource, { kind: 'version' }> {
  const { versioning } = fake();
  const commits = versioning.historyPage(PAGE, ['commit']).items.toReversed();
  for (const entry of commits) {
    if (entry.kind !== 'commit') continue;
    const row = versioning.changesPage(entry.commit.id, PAGE).items.find((change) => change.path === path);
    if (row?.after != null) return { kind: 'version', version: { commit: entry.commit.id, path }, side: row.after };
  }
  throw new Error(`no stored version of ${path}`);
}

/** The bytes' URL of a version source. */
function urlOf(source: Extract<PreviewFileSource, { kind: 'version' }>): string {
  return versionUrl(source.side, nameOf(source.version.path));
}

interface ShowOptions {
  /** Files the small fixture gets besides its own. */
  added?: { path: string; size: number }[];
  /** What the `folio-file` scheme serves, by URL; anything else answers 404 `NotFound`. */
  serve?: () => Record<string, ServedBody>;
}

/** Renders the preview of a source the test picks from the fake shell once it is installed. */
function showFile<Source extends PreviewFileSource>(pick: () => Source, { added = [], serve = () => ({}) }: ShowOptions = {}) {
  const fixture = added.length === 0 ? undefined : smallLibraryWith(...added.map((file) => ({ ...file, size: String(file.size) })));
  const app = renderApp(<div />, { now: NOW, fixture });
  const source = pick();
  const served = new Map(Object.entries(serve()));
  const { fetch, fetched } = serveFiles((url) => served.get(url));
  const invoke = vi.spyOn(app.shell, 'invoke');
  const open = vi.fn();
  const onEscape = vi.fn();
  app.rerender(<PreviewFile source={source} actions={{ open }} onEscape={onEscape} />);
  /** How many times the preview asked the shell for `command`. */
  const asked = (command: string) => invoke.mock.calls.filter(([name]) => name === command).length;
  return { ...app, source, fetch, fetched, asked, open, onEscape };
}

describe('a stored version', () => {
  it('fetches its bytes from the version route, never the file on the disk', async () => {
    const { source, fetched, onEscape } = showFile(() => stored(PS2), {
      serve: () => ({ [urlOf(stored(PS2))]: 'Problem 3 (stored)' }),
    });
    const frame = await screen.findByTitle('Preview of ps2 solutions.md');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await waitFor(() => {
      expect(fetched()).toEqual([urlOf(source)]);
    });

    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    await waitFor(() => {
      expect(posted).toHaveBeenCalled();
    });
    const [render] = posted.mock.calls[0] ?? [];
    expect(render).toMatchObject({ kind: 'render', renderer: 'markdown' });
    expect(new TextDecoder().decode((render as { bytes: ArrayBuffer }).bytes)).toBe('Problem 3 (stored)');
    // Nothing of the file as it is now: neither its bytes nor its thumbnail.
    expect(fetched().some((url) => url.includes('/content/') || url.includes('/thumbnail/'))).toBe(false);

    // Esc in the frame hands the focus to the host's heading.
    send({ kind: 'shortcut', press: { key: 'Escape', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('opens the file the version belongs to now, which has moved since', async () => {
    const { user, open, asked } = showFile(() => stored(EXERCISE));
    // A Word version shows the card, whose note does not ask to open "it": Open opens today's file.
    expect(await screen.findByText('Previews of Word, Excel and PowerPoint files come in a later version.')).toBeInTheDocument();
    // The card waits for the lookup, so Open is there as soon as the card is.
    const button = screen.getByRole('button', { name: 'Open with default app' });
    expect(screen.getByText('习题 1.docx')).toBeInTheDocument();
    await user.click(button);
    expect(open).toHaveBeenCalledWith(refOf(`${LINEAR}/习题/习题 1.docx`));
    expect(asked('locate_version')).toBe(1);
    expect(asked('get_entry')).toBe(0);
  });

  it('offers no Open once the file is gone', async () => {
    showFile(() => {
      fake().deleteFile(`${LINEAR}/习题/习题 1.docx`);
      return stored(EXERCISE);
    });
    expect(await screen.findByText('Previews of Word, Excel and PowerPoint files come in a later version.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open with default app' })).toBeNull();
  });

  it('says why it cannot be read in its own words, and tries again', async () => {
    const { user, fetch, source } = showFile(() => stored(PS2), {
      serve: () => ({ [urlOf(stored(PS2))]: '# ps2' }),
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'X-Folio-Error': 'Pruned' } }));
    expect(await screen.findByText('Can’t show this version')).toBeInTheDocument();
    expect(screen.getByText('Folio no longer keeps this version. Old Word versions are thinned out over time.')).toBeInTheDocument();
    // The failure offers the file as it is now, like the card.
    expect(screen.getByRole('button', { name: 'Open with default app' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Preview of ps2 solutions.md')).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith(urlOf(source), expect.anything());

    // A failure without a version route code: not the reasons a file on the disk fails for.
    const { send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'failed', reason: 'renderer' });
    expect(await screen.findByText('Folio couldn’t read this version from the library’s history. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/open in another app/)).toBeNull();
  });

  it('has no thumbnail: a HEIC version shows the card, and a failed lookup shows it without Open', async () => {
    const heic = 'Personal/Photos/IMG_2031.HEIC';
    const { fetched } = showFile(() => ({
      kind: 'version',
      // No commit holds this path, so the lookup fails.
      version: { commit: stored(WEEK2).version.commit, path: heic },
      side: { hash: `b3:${'ab'.repeat(32)}`, size: '2800000' },
    }));
    expect(await screen.findByText('Folio can’t show this image format.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open with default app' })).toBeNull();
    expect(fetched().some((url) => url.includes('/thumbnail/'))).toBe(false);
  });

  it('shows a too-large version without fetching it', async () => {
    const { fetched } = showFile(() => ({ ...stored(WEEK2), side: { ...stored(WEEK2).side, size: String(3 * 1024 * 1024) } }));
    expect(await screen.findByText('This version is too large to preview.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open with default app' })).toBeInTheDocument();
    expect(fetched()).toEqual([]);
  });
});

describe('a stored note’s images', () => {
  /** Next to where ps2 solutions.md is now, not where the commit had it. */
  const figure = `${MAT}/Problem sets/figure.png`;
  const serve = () => ({ [urlOf(stored(PS2))]: '![a](figure.png)', [contentUrl(refOf(figure))]: new Uint8Array([137, 80, 78, 71]) });

  it('are the images next to the file the version belongs to now', async () => {
    showFile(() => stored(PS2), { added: [{ path: figure, size: 8 }], serve });
    await screen.findByTitle('Preview of ps2 solutions.md');
    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'images', paths: ['figure.png', 'missing.png'] });
    await waitFor(() => {
      expect(posted).toHaveBeenCalledTimes(3);
    });
    const answers = posted.mock.calls.slice(1).map(([message]) => message as { path: string; image: { type: string } | null });
    const byPath = Object.fromEntries(answers.map((answer) => [answer.path, answer.image]));
    expect(byPath['figure.png']).toMatchObject({ type: 'image/png' });
    expect(byPath['missing.png']).toBeNull();
  });

  it('are all missing when the file is gone, without asking the shell', async () => {
    const { asked } = showFile(
      () => {
        fake().deleteFile(`${MAT}/Problem sets/ps2 solutions.md`);
        return stored(PS2);
      },
      { added: [{ path: figure, size: 8 }], serve },
    );
    await screen.findByTitle('Preview of ps2 solutions.md');
    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'images', paths: ['figure.png'] });
    await waitFor(() => {
      expect(posted).toHaveBeenCalledTimes(2);
    });
    expect(posted.mock.calls[1]?.[0]).toEqual({ kind: 'image', path: 'figure.png', image: null });
    expect(asked('resolve_paths')).toBe(0);
  });
});
