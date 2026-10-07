import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox, CheckboxMark } from './Checkbox';

describe('Checkbox', () => {
  it('is named by its label, and toggles with a click and with Space', async () => {
    const user = userEvent.setup();
    function Originals() {
      const [on, setOn] = useState(false);
      return (
        <Checkbox isSelected={on} onChange={setOn}>
          Move the originals to the Recycle Bin
        </Checkbox>
      );
    }
    render(<Originals />);
    const box = screen.getByRole('checkbox', { name: 'Move the originals to the Recycle Bin' });
    expect(box).not.toBeChecked();
    await user.click(screen.getByText('Move the originals to the Recycle Bin'));
    expect(box).toBeChecked();
    await user.keyboard(' ');
    expect(box).not.toBeChecked();
  });

  it('shows a mixed state that a press turns on, and takes an accessible name without a label', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Checkbox aria-label="Include all changes" isSelected={false} isIndeterminate onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Include all changes' });
    expect(box).toBePartiallyChecked();
    // A dash, not a check, and nothing written after the box.
    expect(container.querySelector('.checkbox')).toHaveAttribute('data-indeterminate');
    expect(container.querySelector('.checkbox__label')).toBeNull();
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('cannot be changed while disabled, and draws its box faded', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Checkbox aria-label="Include all changes" isSelected isDisabled onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Include all changes' });
    expect(box).toBeDisabled();
    await user.click(box);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('.checkbox')).toHaveAttribute('data-disabled');
  });
});

describe('CheckboxMark', () => {
  it('draws the state of the row around it, out of the accessibility tree and the tab order', () => {
    const { container, rerender } = render(<CheckboxMark state onPress={vi.fn()} />);
    const mark = container.querySelector('.checkbox');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('data-selected');
    expect(container.querySelector('[tabindex]')).toBeNull();
    rerender(<CheckboxMark state="mixed" onPress={vi.fn()} />);
    expect(mark).toHaveAttribute('data-indeterminate');
    expect(mark).not.toHaveAttribute('data-selected');
  });

  it('hands a click to its own handler only, keeps the focus where it is, and does nothing while disabled', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    const onRowClick = vi.fn();
    const { container, rerender } = render(
      // An option that selects itself on a click, like a row of the Changes list.
      <div role="option" aria-selected={false} tabIndex={0} onClick={onRowClick}>
        <CheckboxMark state={false} onPress={onPress} />
        notes.md
      </div>,
    );
    const mark = container.querySelector('.checkbox');
    if (mark === null) throw new Error('no mark');
    // The press does not take the focus from where it is.
    expect(fireEvent.mouseDown(mark)).toBe(false);
    await user.click(mark);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    // Shift+click: the host toggles a range.
    await user.keyboard('{Shift>}');
    await user.click(mark);
    await user.keyboard('{/Shift}');
    expect(onPress).toHaveBeenLastCalledWith(expect.objectContaining({ shiftKey: true }));
    expect(onRowClick).not.toHaveBeenCalled();
    rerender(
      <div role="option" aria-selected={false} tabIndex={0} onClick={onRowClick}>
        <CheckboxMark state={false} isDisabled onPress={onPress} />
        notes.md
      </div>,
    );
    await user.click(mark);
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
