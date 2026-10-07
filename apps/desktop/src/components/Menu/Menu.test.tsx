import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArrowDown, ArrowUp, Copy, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { Key, Selection } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../Button/Button';
import { ContextMenu, Menu, type MenuAnchor, MenuButton, MenuItem, MenuSection } from './Menu';

const REASON = 'This is the version you have now.';

/** "More" of the compact diff pane: Restore… disabled with its reason (diff/DiffHeader.tsx). */
function More({ onAction, onRestore }: { onAction: (key: Key) => void; onRestore: () => void }) {
  return (
    <MenuButton trigger={<Button>More</Button>}>
      <Menu aria-label="More" onAction={onAction}>
        <MenuItem id="open">Open with default app</MenuItem>
        <MenuItem id="restore" icon={RotateCcw} isDisabled note={REASON} onAction={onRestore}>
          Restore…
        </MenuItem>
        <MenuItem id="copy" icon={Copy}>
          Copy path
        </MenuItem>
      </Menu>
    </MenuButton>
  );
}

async function openMore(onAction = vi.fn(), onRestore = vi.fn()) {
  const user = userEvent.setup();
  render(<More onAction={onAction} onRestore={onRestore} />);
  screen.getByRole('button', { name: 'More' }).focus();
  await user.keyboard('{Enter}');
  const menu = await screen.findByRole('menu', { name: 'More' });
  await waitFor(() => {
    expect(screen.getByRole('menuitem', { name: 'Open with default app' })).toHaveFocus();
  });
  return { user, menu, restore: screen.getByRole('menuitem', { name: 'Restore…' }) };
}

describe('a disabled menu item', () => {
  it('stays in reach of the arrow keys, Home, End and type-ahead, and says why', async () => {
    const { user, restore } = await openMore();
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveAttribute('data-disabled');
    expect(restore).toHaveAccessibleName('Restore…');
    expect(restore).toHaveAccessibleDescription(REASON);
    expect(restore.querySelector('.menu-item__note')).toHaveTextContent(REASON);

    await user.keyboard('{ArrowDown}');
    expect(restore).toHaveFocus();
    expect(restore).toHaveAttribute('data-focus-visible');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(restore).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Open with default app' })).toHaveFocus();
    await user.keyboard('r');
    expect(restore).toHaveFocus();
  });

  it('neither runs its action nor the menu’s on Enter, Space or a click, and leaves the menu open', async () => {
    const onAction = vi.fn();
    const onRestore = vi.fn();
    const { user, menu, restore } = await openMore(onAction, onRestore);
    await user.keyboard('{ArrowDown}');
    expect(restore).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(menu).toBeInTheDocument();
    expect(restore).toHaveFocus();

    // The enabled items still run and close the menu.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onAction).toHaveBeenCalledExactlyOnceWith('copy', undefined);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});

/** A row's context menu whose `disabledKeys` names Move up, as on the first row (settings/parts/RowMenu.tsx). */
function RowContextMenu({ onAction }: { onAction: (key: Key) => void }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        type="button"
        onContextMenu={(event) => {
          setAnchor({ x: event.clientX, y: event.clientY });
        }}
      >
        Fall 2026
      </button>
      <ContextMenu
        anchor={anchor}
        label="Fall 2026"
        onClose={() => {
          setAnchor(null);
        }}
      >
        <Menu aria-label="Fall 2026" autoFocus="first" disabledKeys={['up']} onAction={onAction}>
          <MenuItem id="up" icon={ArrowUp}>
            Move up
          </MenuItem>
          <MenuItem id="down" icon={ArrowDown}>
            Move down
          </MenuItem>
        </Menu>
      </ContextMenu>
    </>
  );
}

describe('a key in the menu’s disabledKeys', () => {
  it('is focusable and inert as an isDisabled item is, in a context menu too', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<RowContextMenu onAction={onAction} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Fall 2026' }), { clientX: 40, clientY: 20 });
    const up = await screen.findByRole('menuitem', { name: 'Move up' });
    await waitFor(() => {
      expect(up).toHaveFocus();
    });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(up).toHaveAttribute('data-disabled');

    await user.keyboard('{Enter}');
    await user.click(up);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Fall 2026' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    const down = screen.getByRole('menuitem', { name: 'Move down' });
    expect(down).toHaveFocus();
    expect(down).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledExactlyOnceWith('down', undefined);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});

/**
 * Tags ▸ (library/menus/EntryMenu.tsx): Slides comes from a folder above, checked and disabled;
 * Exams cannot be added, disabled and unchecked.
 */
function Tags({ onChange }: { onChange: (keys: Selection) => void }) {
  const [selected, setSelected] = useState<Selection>(new Set(['slides']));
  return (
    <MenuButton trigger={<Button>Tags</Button>}>
      <Menu aria-label="Tags">
        <MenuSection
          aria-label="Tags"
          selectionMode="multiple"
          selectedKeys={selected}
          onSelectionChange={(keys) => {
            onChange(keys);
            setSelected(keys);
          }}
        >
          <MenuItem id="slides" isDisabled note="From folder">
            Slides
          </MenuItem>
          <MenuItem id="exams" isDisabled>
            Exams
          </MenuItem>
          <MenuItem id="notes">Notes</MenuItem>
        </MenuSection>
      </Menu>
    </MenuButton>
  );
}

describe('a disabled checkable item', () => {
  it('keeps its check through Enter, Space and clicks, while the others toggle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Tags onChange={onChange} />);
    screen.getByRole('button', { name: 'Tags' }).focus();
    await user.keyboard('{Enter}');
    const slides = await screen.findByRole('menuitemcheckbox', { name: 'Slides' });
    const exams = screen.getByRole('menuitemcheckbox', { name: 'Exams' });
    const notes = screen.getByRole('menuitemcheckbox', { name: 'Notes' });
    await waitFor(() => {
      expect(slides).toHaveFocus();
    });
    expect(slides).toHaveAttribute('aria-checked', 'true');
    expect(slides).toHaveAttribute('aria-disabled', 'true');
    expect(slides).toHaveAccessibleDescription('From folder');

    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    await user.click(slides);
    expect(slides).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}');
    expect(exams).toHaveFocus();
    await user.keyboard(' ');
    await user.click(exams);
    expect(exams).toHaveAttribute('aria-checked', 'false');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Tags' })).toBeInTheDocument();

    // Space toggles an enabled tag and keeps the menu open (library-actions §2.7).
    await user.keyboard('{ArrowDown}');
    expect(notes).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledOnce();
    expect([...(onChange.mock.lastCall?.[0] as Set<Key>)].sort()).toEqual(['notes', 'slides']);
    expect(notes).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu', { name: 'Tags' })).toBeInTheDocument();
  });
});
