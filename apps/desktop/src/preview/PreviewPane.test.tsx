import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewActions, PreviewPaneProps } from '../app/panes';
import { Menu, MenuItem } from '../components/Menu/Menu';
import { contentUrl, type EntryRef } from '../ipc';
import { smallLibraryWith } from '../test/fixtures';
import { renderApp } from '../test/render';
import { SIZE } from '../tokens/tokens';
import { PreviewPane } from './PreviewPane';
import type { FrameMessage } from './protocol';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const NOTE = `${MAT}/week 2 notes.md`;

function actions(): PreviewActions {
  return { open: vi.fn(), showInExplorer: vi.fn(), setTags: vi.fn() };
}

interface ShowOptions {
  scenario?: 'small' | 'read-only';
  /** Files the small fixture gets besides its own. */
  added?: { path: string; size: number }[];
  /** What the `folio-file` scheme serves, by library path; anything else answers 404 `NotFound`. */
  files?: Record<string, string | Uint8Array<ArrayBuffer>>;
  props?: Partial<PreviewPaneProps>;
}

/** Renders the pane for `path` of the small fixture against the fake shell. */
function showPreview(path: string, { scenario, added = [], files, props = {} }: ShowOptions = {}) {
  const fixture = added.length === 0 ? undefined : smallLibraryWith(...added.map((file) => ({ ...file, size: String(file.size) })));
  const app = renderApp(<div />, fixture === undefined ? { scenario } : { fixture });
  const refOf = (at: string): EntryRef => {
    const node = app.shell.library.at(at);
    if (node === undefined) throw new Error(`no ${at} in the fixture`);
    return app.shell.library.ref(node);
  };
  const served = new Map(Object.entries(files ?? {}).map(([at, body]) => [contentUrl(refOf(at)), body]));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    await Promise.resolve();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = served.get(url);
    if (body === undefined) return new Response(null, { status: 404, headers: { 'X-Folio-Error': 'NotFound' } });
    return new Response(init?.method === 'HEAD' ? null : body, { status: 200 });
  });
  const entry = refOf(path);
  const preview = actions();
  app.rerender(<PreviewPane entry={entry} actions={preview} {...props} />);
  return { ...app, entry, preview, fetch };
}

/** Messages from the preview's frame, as its document would send them. */
function frameMessages() {
  const frame = document.querySelector('iframe');
  if (frame?.contentWindow == null) throw new Error('no frame');
  const target = frame.contentWindow;
  const posted = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
  const send = (data: FrameMessage) => {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: target }));
    });
  };
  return { posted, send };
}

describe('the header and tag row', () => {
  it('shows where the file is, its tags, size and actions', async () => {
    const { user, entry, preview } = showPreview(`${MAT}/Exams/Midterm/Midterm review.md`);
    const pane = await screen.findByRole('group', { name: 'Preview of Midterm review.md' });
    const heading = within(pane).getByRole('heading', { level: 2 });
    await waitFor(() => {
      expect(heading).toHaveTextContent('MAT232/Exams/Midterm/Midterm review.md');
    });
    const tags = await within(pane).findByRole('grid', { name: 'Tags' });
    expect(within(tags).getByRole('row', { name: 'Notes' })).toBeInTheDocument();
    expect(within(pane).getByRole('grid', { name: 'Tags from the folders above it' })).toHaveTextContent('Exams');
    expect(pane).toHaveTextContent(/KB · Modified/);

    // The header's button comes first; the body may offer its own.
    const [open] = within(pane).getAllByRole('button', { name: 'Open with default app' });
    if (open === undefined) throw new Error('no Open button');
    await user.click(open);
    await user.click(within(pane).getByRole('button', { name: 'Show in File Explorer' }));
    expect(preview.open).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id }));
    expect(preview.showInExplorer).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id }));

    await user.click(within(tags).getByRole('button', { name: /Remove tag/ }));
    expect(preview.setTags).toHaveBeenCalledWith([expect.objectContaining({ id: entry.id })], [], [expect.any(String)]);
  });

  it('starts with Back and keeps only Open and More in a narrow window', async () => {
    const width = window.innerWidth;
    act(() => {
      window.innerWidth = SIZE.narrowBreakpoint - 1;
      window.dispatchEvent(new Event('resize'));
    });
    const onBack = vi.fn();
    const { user } = showPreview(NOTE, { props: { onBack, moreMenu: <div /> } });
    const pane = await screen.findByRole('group', { name: 'Preview of week 2 notes.md' });
    await user.click(within(pane).getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(within(pane).queryByRole('button', { name: 'Show in File Explorer' })).toBeNull();
    expect(within(pane).getByRole('button', { name: 'More' })).toBeInTheDocument();
    act(() => {
      window.innerWidth = width;
      window.dispatchEvent(new Event('resize'));
    });
  });

  it('offers no tag editing in a read-only library', async () => {
    showPreview(NOTE, { scenario: 'read-only', props: { tagMenu: <div /> } });
    const pane = await screen.findByRole('group', { name: 'Preview of week 2 notes.md' });
    await within(pane).findByRole('row', { name: 'Notes' });
    expect(within(pane).queryByRole('button', { name: /Remove tag/ })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Add or remove tags' })).toBeNull();
  });

  it('opens the host’s tag menu from "+ Tag"', async () => {
    const tagMenu = (
      <Menu aria-label="Tags">
        <MenuItem id="notes">Notes</MenuItem>
      </Menu>
    );
    const { user } = showPreview(NOTE, { props: { tagMenu } });
    await user.click(await screen.findByRole('button', { name: 'Add or remove tags' }));
    expect(await screen.findByRole('menuitem', { name: 'Notes' })).toBeInTheDocument();
  });
});

describe('the body by type', () => {
  it('gives Office and other files the card with "Open with default app"', async () => {
    const { user, preview } = showPreview('Fall 2026/线性代数/习题/习题 1.docx');
    expect(await screen.findByText(/Previews of Word, Excel and PowerPoint/)).toBeInTheDocument();
    const open = screen.getAllByRole('button', { name: 'Open with default app' }).at(-1);
    if (open === undefined) throw new Error('no Open button');
    await user.click(open);
    expect(preview.open).toHaveBeenCalledTimes(1);
  });

  it('shows an image by URL, and why it could not be read', async () => {
    const { entry, fetch } = showPreview('Personal/Photos/Screenshot 2026-09-12.png');
    const image = await screen.findByRole('img', { name: 'Screenshot 2026-09-12.png' });
    expect(image).toHaveAttribute('src', contentUrl(entry));
    fetch.mockResolvedValue(new Response(null, { status: 409, headers: { 'X-Folio-Error': 'InUse' } }));
    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    expect(await screen.findByText('Can’t show this file')).toBeInTheDocument();
    expect(screen.getByText(/Another app is using this file/)).toBeInTheDocument();
  });

  it('starts the frame while it fetches, sends the file once ready, and shows the frame’s failure', async () => {
    const { entry, fetch } = showPreview(NOTE, { files: { [NOTE]: '# Week 2' } });
    const frame = await screen.findByTitle('Preview of week 2 notes.md');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(fetch).toHaveBeenCalledWith(contentUrl(entry), expect.anything());

    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    await waitFor(() => {
      expect(posted).toHaveBeenCalled();
    });
    const [render] = posted.mock.calls[0] ?? [];
    expect(render).toMatchObject({ kind: 'render', renderer: 'markdown' });
    expect(new TextDecoder().decode((render as { bytes: ArrayBuffer }).bytes)).toBe('# Week 2');

    send({ kind: 'failed', reason: 'corrupt' });
    expect(await screen.findByText(/It may be damaged or password-protected/)).toBeInTheDocument();
  });

  it('answers a note’s images with the files next to it, and nothing else', async () => {
    const figure = `${MAT}/figure.png`;
    showPreview(NOTE, {
      added: [{ path: figure, size: 8 }],
      files: { [NOTE]: '![a](figure.png)', [figure]: new Uint8Array([137, 80, 78, 71]) },
    });
    await screen.findByTitle('Preview of week 2 notes.md');
    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'images', paths: ['figure.png', 'Lectures/Lecture%2001.pdf', '/etc/passwd', 'missing.png'] });

    await waitFor(() => {
      expect(posted).toHaveBeenCalledTimes(5);
    });
    const answers = posted.mock.calls.slice(1).map(([message]) => message as { path: string; image: { type: string } | null });
    const byPath = Object.fromEntries(answers.map((answer) => [answer.path, answer.image]));
    expect(byPath['figure.png']).toMatchObject({ type: 'image/png' });
    // A PDF next to the note is a catalogued file, but not an image: the frame never gets it.
    expect(byPath['Lectures/Lecture%2001.pdf']).toBeNull();
    expect(byPath['/etc/passwd']).toBeNull();
    expect(byPath['missing.png']).toBeNull();
  });

  it('shows a link’s address with "Copy address"', async () => {
    showPreview(NOTE, { files: { [NOTE]: '[x](https://example.com/)' } });
    await screen.findByTitle('Preview of week 2 notes.md');
    const { send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'link', href: 'https://example.com/syllabus', rect: { x: 10, y: 20, width: 40, height: 16 } });
    const dialog = await screen.findByRole('dialog', { name: 'Link address' });
    expect(dialog).toHaveTextContent('https://example.com/syllabus');
    expect(within(dialog).getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
  });

  it('draws the PDF pill from the frame and sends its commands', async () => {
    const lecture = `${MAT}/Lectures/Lecture 01.pdf`;
    const { user } = showPreview(lecture, { files: { [lecture]: '%PDF-1.7' } });
    await screen.findByTitle('Preview of Lecture 01.pdf');
    const { posted, send } = frameMessages();
    send({ kind: 'ready' });
    send({ kind: 'pdfState', page: 1, pages: 4, percent: 100 });
    const pill = await screen.findByRole('toolbar', { name: 'Page and zoom' });
    expect(pill).toHaveTextContent('1 / 4');
    expect(within(pill).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(within(pill).getByRole('button', { name: 'Next page' }));
    await user.click(within(pill).getByRole('button', { name: 'Zoom in' }));
    expect(posted).toHaveBeenCalledWith({ kind: 'pdf', goToPage: 2 }, '*', []);
    expect(posted).toHaveBeenCalledWith({ kind: 'pdf', zoom: 110 }, '*', []);
  });

  it('says why reading failed, and tries again', async () => {
    const { user, fetch } = showPreview(NOTE, { files: { [NOTE]: '# ok' } });
    fetch.mockResolvedValueOnce(new Response(null, { status: 409, headers: { 'X-Folio-Error': 'NotLocal' } }));
    expect(await screen.findByText('Can’t show this file')).toBeInTheDocument();
    expect(screen.queryByText(/Folio couldn’t read it/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Preview of week 2 notes.md')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows "too large to preview" without fetching', async () => {
    const huge = `${MAT}/huge.md`;
    const { fetch } = showPreview(huge, { added: [{ path: huge, size: 3 * 1024 * 1024 }] });
    expect(await screen.findByText(/too large to preview/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
