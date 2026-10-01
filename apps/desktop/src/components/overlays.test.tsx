import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pencil, Tag, Trash } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import common from '../i18n/locales/en/common.json';
import { Button } from './Button/Button';
import { DialogFrame, Modal, WINDOW_BAR_ATTRIBUTE } from './Dialog/Dialog';
import {
  ContextMenu,
  Menu,
  type MenuAnchor,
  MenuButton,
  MenuItem,
  MenuSeparator,
  Submenu,
  useContextMenuTrigger,
} from './Menu/Menu';
import { TagDot } from './TagDot/TagDot';
import { Toast } from './Toast/Toast';

describe('MenuButton', () => {
  it('opens a menu of items with icons and shortcuts, and runs the chosen one', async () => {
    const onAction = vi.fn();
    render(
      <MenuButton trigger={<Button>More</Button>}>
        <Menu aria-label="More" onAction={onAction}>
          <MenuItem id="rename" icon={Pencil} shortcut="F2">
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem id="delete" icon={Trash} shortcut="Del" destructive>
            Delete
          </MenuItem>
          <MenuItem id="add" isDisabled>
            Add files…
          </MenuItem>
        </Menu>
      </MenuButton>,
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    await userEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'More' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toHaveTextContent('F2');
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toHaveAttribute('data-destructive', 'true');
    expect(screen.getByRole('menuitem', { name: /Add files/ })).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(onAction.mock.calls[0]?.[0]).toBe('delete');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('checks tag items, shows mixed ones with a minus, and opens a submenu with the Right arrow', async () => {
    render(
      <MenuButton trigger={<Button>Open</Button>}>
        <Menu aria-label="File">
          <Submenu trigger={<MenuItem icon={Tag}>Tags</MenuItem>}>
            <Menu aria-label="Tags" selectionMode="multiple" defaultSelectedKeys={['notes']}>
              <MenuItem id="notes" icon={<TagDot color="blue" />}>
                Notes
              </MenuItem>
              <MenuItem id="exams" icon={<TagDot color="red" />} mixed>
                Exams
              </MenuItem>
            </Menu>
          </Submenu>
        </Menu>
      </MenuButton>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const tags = screen.getByRole('menuitem', { name: 'Tags' });
    expect(tags).toHaveAttribute('aria-haspopup', 'menu');
    tags.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menu', { name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Notes' })).toBeChecked();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Exams' }).querySelector('.lucide-minus')).not.toBeNull();
  });
});

function ContextHost({ onAction }: { onAction: (key: unknown) => void }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { contextMenuProps } = useContextMenuTrigger((point) => {
    setAnchor(point);
  });
  return (
    <>
      <button type="button" {...contextMenuProps}>
        ps2.pdf
      </button>
      <ContextMenu
        anchor={anchor}
        label="ps2.pdf"
        onClose={() => {
          setAnchor(null);
        }}
      >
        <Menu aria-label="ps2.pdf" autoFocus="first" onAction={onAction}>
          <MenuItem id="rename">Rename</MenuItem>
        </Menu>
      </ContextMenu>
    </>
  );
}

describe('ContextMenu', () => {
  it('closes when an item is chosen, as a menu with a trigger does', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<ContextHost onAction={onAction} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'ps2.pdf' }), { clientX: 40, clientY: 20 });
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction.mock.lastCall?.[0]).toBe('rename');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('opens at the pointer on right-click, focuses its first item, and Esc returns focus', async () => {
    render(<ContextHost onAction={vi.fn()} />);
    const row = screen.getByRole('button', { name: 'ps2.pdf' });
    row.focus();
    fireEvent.contextMenu(row, { clientX: 40, clientY: 20 });

    expect(await screen.findByRole('menu', { name: 'ps2.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // React Aria restores focus in the next animation frame.
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });
});

describe('dialogs', () => {
  function Host({ onClose = vi.fn() }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <header {...{ [WINDOW_BAR_ATTRIBUTE]: '' }}>
          <button type="button">Minimize</button>
        </header>
        <Button
          onPress={() => {
            setOpen(true);
          }}
        >
          Delete course…
        </Button>
        <DialogFrame
          isOpen={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) onClose();
          }}
          title="Delete MAT232?"
          footer={
            <>
              <Button size="dialog" autoFocus>
                Cancel
              </Button>
              <Button size="dialog" variant="danger">
                Delete course
              </Button>
            </>
          }
        >
          <p>The course folder goes to the Recycle Bin.</p>
        </DialogFrame>
      </>
    );
  }

  it('opens a modal named by its title, traps focus, and closes on Esc with focus back on the opener', async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Delete course…' });
    await userEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Delete MAT232?' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Tab cycles inside: Cancel → Delete course → Close (Esc) → Cancel.
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: common.closeDialog })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('closes with its close button', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete course…' }));
    await userEvent.click(screen.getByRole('button', { name: common.closeDialog }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never closes when the window bar is pressed, even when the scrim would close it', async () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <header {...{ [WINDOW_BAR_ATTRIBUTE]: '' }}>
          <span>Folio</span>
        </header>
        <Modal isOpen onOpenChange={onOpenChange} isDismissable aria-label="Search">
          <p>Results</p>
        </Modal>
      </>,
    );
    await userEvent.click(screen.getByText('Folio'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  it('is an alert for errors and a status message otherwise, with its actions and close button', async () => {
    const onDismiss = vi.fn();
    const onCopy = vi.fn();
    const { rerender } = render(
      <Toast
        tone="danger"
        title="Couldn't minimize the window"
        body="Press Windows+Down to minimize it instead."
        actions={[{ label: 'Copy details', onPress: onCopy }]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't minimize the window");
    await userEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await userEvent.click(screen.getByRole('button', { name: common.dismiss }));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();

    rerender(<Toast tone="progress" title="Adding 12 files to MAT232" progress={58} dismissLabel="hide" onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('Adding 12 files to MAT232');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByRole('button', { name: common.hide })).toBeInTheDocument();
  });

  it('says when the pointer or focus is inside, so its timer can wait', async () => {
    const onHold = vi.fn();
    render(<Toast tone="success" title="Copied the path" onHold={onHold} onDismiss={vi.fn()} />);
    const toast = screen.getByRole('status');
    fireEvent.pointerEnter(toast);
    expect(onHold).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(toast);
    expect(onHold).toHaveBeenLastCalledWith(false);
    await userEvent.tab();
    expect(onHold).toHaveBeenLastCalledWith(true);
  });

  it('stops speaking while it fades out', () => {
    render(<Toast tone="danger" title="Couldn't close Folio" leaving onDismiss={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
