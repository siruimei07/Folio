import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DialogFrame, type DialogFrameProps, Modal, MODAL_ATTRIBUTE, type ModalProps } from './Dialog';

/** The overlay that places the open dialog (workspace-history handoff §8.5). */
function overlay(): HTMLElement {
  const element = screen.getByRole('dialog').closest<HTMLElement>(`[${MODAL_ATTRIBUTE}]`);
  if (element === null) throw new Error('The dialog has no overlay.');
  return element;
}

function frame(props: Partial<DialogFrameProps>) {
  render(
    <DialogFrame isOpen onOpenChange={() => undefined} title="Move notes.md" {...props}>
      <p>Body</p>
    </DialogFrame>,
  );
}

function modal(props: Partial<ModalProps>) {
  render(
    <Modal isOpen onOpenChange={() => undefined} aria-label="Settings" {...props}>
      <p>Body</p>
    </Modal>,
  );
}

describe('dialog placement', () => {
  it.each([
    ['a small frame is a confirmation', { size: 'small' }, 'confirmation'],
    ['a frame is small unless said', {}, 'confirmation'],
    ['a medium frame is a form', { size: 'medium' }, 'form'],
    ['a large frame is a form', { size: 'large' }, 'form'],
    ['a small form says so', { size: 'small', placement: 'form' }, 'form'],
    ['a medium confirmation says so', { size: 'medium', placement: 'confirmation' }, 'confirmation'],
  ] satisfies [string, Partial<DialogFrameProps>, string][])('%s', (_, props, placement) => {
    frame(props);
    expect(overlay()).toHaveAttribute('data-placement', placement);
  });

  it('centres a bare modal, such as the settings frame, unless it says otherwise', () => {
    modal({});
    expect(overlay()).toHaveAttribute('data-placement', 'center');
  });

  it('places a bare form modal at the form anchor', () => {
    modal({ placement: 'form' });
    expect(overlay()).toHaveAttribute('data-placement', 'form');
  });

  it('places a bare confirmation modal at the confirmation anchor', () => {
    modal({ placement: 'confirmation' });
    expect(overlay()).toHaveAttribute('data-placement', 'confirmation');
  });

  it('leaves the search scrim to place its own dialog', () => {
    modal({ scrim: 'search', placement: 'confirmation' });
    expect(overlay()).toHaveAttribute('data-scrim', 'search');
    expect(overlay()).not.toHaveAttribute('data-placement');
  });
});
