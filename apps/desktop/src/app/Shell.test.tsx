import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { History, LibraryBig } from 'lucide-react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DialogFrame } from '../components/Dialog/Dialog';
import shell from '../i18n/locales/en/shell.json';
import titlebar from '../i18n/locales/en/titlebar.json';
import { SIZE } from '../tokens/tokens';
import { watchLayout } from './layout';
import { useCanShowView, useNavigation } from './navigation';
import type { DialogComponentProps, ShellRegistry, ToolbarControlProps } from './registry';
import { Shell } from './Shell';
import { showToast } from './toasts';
import { ToastRegion } from './ToastRegion';
import { installShortcuts } from './shortcuts';

function resizeWindow(width: number): void {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

/** A view that counts its effects, to see what `<Activity>` keeps and stops. */
const mounts = { library: 0, history: 0 };
function Counter({ id }: { id: 'library' | 'history' }) {
  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    mounts[id] += 1;
  }, [id]);
  return (
    <button
      type="button"
      onClick={() => {
        setClicks(clicks + 1);
      }}
    >
      {`${id} clicked ${String(clicks)}`}
    </button>
  );
}

function SearchDialog({ isOpen, onClose }: DialogComponentProps<'search'>) {
  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Search"
    >
      <p>Results</p>
    </DialogFrame>
  );
}

function Semester({ compact }: ToolbarControlProps) {
  return <span>{compact ? 'Fall 26' : 'Fall 2026'}</span>;
}

const views: ShellRegistry['views'] = [
  { id: 'library', icon: LibraryBig, label: 'rail.library', key: '1', component: () => <Counter id="library" /> },
  { id: 'history', icon: History, label: 'rail.history', key: '3', component: () => <Counter id="history" /> },
];

function registry(overrides: Partial<ShellRegistry> = {}): ShellRegistry {
  return { views, dialogs: {}, toolbar: {}, ...overrides };
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
  mounts.library = 0;
  mounts.history = 0;
  resizeWindow(1280);
  uninstall = installShortcuts();
});

afterEach(() => {
  uninstall();
});

describe('Shell', () => {
  it('shows the active view in the content region and marks it on the rail', () => {
    render(<Shell registry={registry()} />);
    const rail = screen.getByRole('navigation', { name: shell.rail.label });
    expect(within(rail).getByRole('button', { name: shell.rail.library })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('button', { name: shell.rail.history })).not.toHaveAttribute('aria-current');
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'library clicked 0' })).toBeVisible();
  });

  it('keeps a hidden view mounted with its state, and mounts a view the first time it shows', async () => {
    render(<Shell registry={registry()} />);
    await userEvent.click(screen.getByRole('button', { name: 'library clicked 0' }));
    expect(mounts.history).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: shell.rail.history }));
    expect(screen.getByRole('button', { name: 'history clicked 0' })).toBeVisible();
    expect(mounts.history).toBe(1);

    await userEvent.keyboard('{Control>}1{/Control}');
    expect(screen.getByRole('button', { name: 'library clicked 1' })).toBeVisible();
    // Hidden, not unmounted: its effects stop and start again, its state stays.
    expect(screen.getByText('history clicked 0')).not.toBeVisible();
  });

  it('shows the toolbar controls and dialog buttons of registered lanes only', () => {
    const { unmount } = render(<Shell registry={registry()} />);
    expect(screen.queryByRole('button', { name: shell.toolbar.search })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: shell.rail.librarySettings })).not.toBeInTheDocument();
    expect(screen.queryByText('Fall 2026')).not.toBeInTheDocument();
    unmount();

    render(
      <Shell
        registry={registry({
          dialogs: { search: SearchDialog, librarySettings: () => null, appSettings: () => null },
          toolbar: { semester: Semester },
        })}
        deviceName="G16"
      />,
    );
    expect(screen.getByRole('button', { name: shell.toolbar.search })).toHaveTextContent('Ctrl K');
    expect(screen.getByText('Fall 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: shell.rail.librarySettings })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('button', { name: 'App settings for this computer (G16)' })).toHaveTextContent('G');
  });

  it('opens search from the toolbar and Ctrl+K, and returns focus when it closes', async () => {
    render(<Shell registry={registry({ dialogs: { search: SearchDialog } })} />);
    const search = screen.getByRole('button', { name: shell.toolbar.search });
    await userEvent.click(search);
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(search).toHaveFocus();
    });

    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    // Ctrl+1 does nothing while a dialog is open.
    await userEvent.keyboard('{Control>}3{/Control}');
    expect(useNavigation.getState().view).toBe('library');
  });

  it('keeps the caption buttons and toasts usable while a dialog hides the rest of the window', async () => {
    render(
      <>
        <Shell registry={registry({ dialogs: { search: SearchDialog } })} />
        <ToastRegion />
      </>,
    );
    act(() => {
      showToast({ tone: 'info', title: 'Copied the path' });
    });
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();

    // React Aria hides everything outside the dialog (inert, or aria-hidden where inert is
    // missing, as in jsdom), except what carries its top-layer marker.
    expect(screen.queryByRole('navigation', { name: shell.rail.label })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: titlebar.minimize })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: titlebar.close })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied the path');
  });

  it('marks the gear as expanded while Library settings is open, and opens it with Ctrl+,', async () => {
    function Settings({ isOpen, onClose }: DialogComponentProps<'librarySettings'>) {
      return (
        <DialogFrame
          isOpen={isOpen}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          title="Library settings"
        >
          <p>Pages</p>
        </DialogFrame>
      );
    }
    render(<Shell registry={registry({ dialogs: { librarySettings: Settings } })} />);
    const gear = screen.getByRole('button', { name: shell.rail.librarySettings });
    expect(gear).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{Control>},{/Control}');
    expect(screen.getByRole('dialog', { name: 'Library settings' })).toBeInTheDocument();
    expect(gear).toHaveAttribute('aria-expanded', 'true');
  });

  it('mounts a dialog once it opens, and keeps the parameters each kind was opened with', () => {
    const seen: unknown[] = [];
    function Settings({ isOpen, params }: DialogComponentProps<'librarySettings'>) {
      seen.push(params);
      return isOpen ? <p>{`settings on ${params?.page ?? 'first page'}`}</p> : null;
    }
    render(<Shell registry={registry({ dialogs: { search: SearchDialog, librarySettings: Settings } })} />);
    expect(seen).toEqual([]);

    act(() => {
      useNavigation.setState({ dialog: { kind: 'librarySettings', params: { page: 'tags' } } });
    });
    expect(screen.getByText('settings on tags')).toBeInTheDocument();
    act(() => {
      useNavigation.setState({ dialog: { kind: 'search', params: undefined } });
    });
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    expect(seen.at(-1)).toEqual({ page: 'tags' });
    expect(seen).not.toContain(undefined);
  });

  it('moves the toolbar into one 40 px bar in a narrow window and back', () => {
    const stop = watchLayout();
    render(<Shell registry={registry({ dialogs: { search: SearchDialog }, toolbar: { semester: Semester } })} />);
    const banner = screen.getByRole('banner');
    expect(banner).toHaveAttribute('data-variant', 'standard');
    expect(within(banner).queryByText('Fall 2026')).not.toBeInTheDocument();

    resizeWindow(SIZE.narrowBreakpoint - 1);
    expect(document.documentElement.dataset.layout).toBe('narrow');
    expect(banner).toHaveAttribute('data-variant', 'narrow');
    expect(within(banner).getByText('Fall 26')).toBeInTheDocument();
    // The same title bar stays mounted, so its caption buttons keep their snap layouts overlay.
    expect(screen.getByRole('banner')).toBe(banner);
    expect(within(banner).getByRole('button', { name: shell.toolbar.search })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: titlebar.close })).toBeInTheDocument();

    resizeWindow(1280);
    expect(banner).toHaveAttribute('data-variant', 'standard');
    stop();
  });

  it('keeps the window usable when a view stops working', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('boom');
    }
    render(
      <Shell
        registry={registry({
          views: [{ id: 'library', icon: LibraryBig, label: 'rail.library', key: '1', component: Broken }],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: shell.viewError.title })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: shell.rail.label })).toBeInTheDocument();
  });

  it('tells views which views are on the rail, for actions that show another view', () => {
    function Hosted() {
      const changes = useCanShowView('changes');
      const history = useCanShowView('history');
      return <p>{`changes ${String(changes)}, history ${String(history)}`}</p>;
    }
    render(
      <Shell
        registry={registry({
          views: [
            { id: 'library', icon: LibraryBig, label: 'rail.library', key: '1', component: Hosted },
            { id: 'history', icon: History, label: 'rail.history', key: '3', component: () => null },
          ],
        })}
      />,
    );
    expect(screen.getByText('changes false, history true')).toBeInTheDocument();
  });
});
