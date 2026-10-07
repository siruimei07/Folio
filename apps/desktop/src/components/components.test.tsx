import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderOpen, List, ListTree, Plus } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import common from '../i18n/locales/en/common.json';
import { LOADING_DELAY_MS } from '../lib/timing';
import { Banner } from './Banner/Banner';
import { Button } from './Button/Button';
import { Callout } from './Callout/Callout';
import { ChangeStatusIcon } from './ChangeStatusIcon/ChangeStatusIcon';
import { CountPill } from './CountPill/CountPill';
import { CourseBadge } from './CourseBadge/CourseBadge';
import { CourseLabel } from './CourseLabel/CourseLabel';
import { FieldError } from './FieldError/FieldError';
import { FileTypeIcon } from './FileTypeIcon/FileTypeIcon';
import { IconButton } from './IconButton/IconButton';
import { MiddleTruncate } from './MiddleTruncate/MiddleTruncate';
import { Panel } from './Panel/Panel';
import { ProgressBar, ProgressRing } from './Progress/Progress';
import { SegmentedControl } from './SegmentedControl/SegmentedControl';
import { Skeleton } from './Skeleton/Skeleton';
import { StateBlock } from './StateBlock/StateBlock';
import { TagChipList, TagToggle } from './TagChip/TagChip';
import { TagDot } from './TagDot/TagDot';

const folder = { id: 'c1', path: 'Fall 2026/MAT232' };

describe('Button and IconButton', () => {
  it('press the action, and not while disabled', async () => {
    const onPress = vi.fn();
    render(
      <>
        <Button variant="accent" icon={Plus} onPress={onPress}>
          Add courses
        </Button>
        <Button isDisabled onPress={onPress}>
          Nothing selected
        </Button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add courses' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nothing selected' }));
    expect(onPress).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Add courses' })).toHaveAttribute('data-variant', 'accent');
  });

  it('names an icon button by its label and shows it with the shortcut on keyboard focus', async () => {
    render(<IconButton icon={Plus} label="Add files" shortcut="Ctrl+O" />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Add files' })).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Add files');
    expect(tooltip).toHaveTextContent('Ctrl+O');
  });

  it('keeps an icon button that cannot act now in the tab order, with the reason under its label, doing nothing', async () => {
    const onPress = vi.fn();
    render(<IconButton icon={Plus} label="Edit message" size="medium" variant="outline" disabledReason="History is read-only." onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Edit message' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-size', 'medium');
    await userEvent.tab();
    expect(button).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Edit messageHistory is read-only.');
    expect(tooltip.querySelector('.icon-button__reason')).toHaveTextContent('History is read-only.');
    await userEvent.click(button);
    await userEvent.keyboard('{Enter} ');
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('course and tag parts', () => {
  it('writes the badge from the abbreviation, the code or the name, and shows only colour when mini', () => {
    const { container } = render(
      <>
        <CourseBadge course={{ folder, name: 'Calculus of Several Variables', abbr: null, code: null, color: 'orange' }} />
        <CourseBadge course={{ folder, name: 'Theory of Computation', abbr: 'ToC', code: 'CSC463', color: null }} size="compact" />
        <CourseBadge course={{ folder, name: 'Calculus', abbr: null, code: 'MAT232', color: 'orange' }} size="mini" />
        <CourseBadge course={{ folder, name: 'Software Design', abbr: null, code: 'CSC207', color: 'teal' }} />
      </>,
    );
    const badges = container.querySelectorAll('.course-badge');
    expect(badges[0]).toHaveTextContent('Cal');
    expect(badges[0]).toHaveAttribute('data-palette', 'orange');
    expect(badges[1]).toHaveTextContent('ToC');
    expect(badges[2]).toBeEmptyDOMElement();
    expect(badges[3]).toHaveTextContent('CSC');
    // Decorative: the label next to the badge names the course.
    badges.forEach((badge) => {
      expect(badge).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('labels a course with its code first, or its name alone', () => {
    const { container } = render(
      <>
        <CourseLabel course={{ code: 'MAT232', name: 'Calculus of Several Variables' }} />
        <CourseLabel course={{ code: null, name: '线性代数' }} />
      </>,
    );
    const [withCode, withoutCode] = container.querySelectorAll('.course-label');
    expect(withCode?.querySelector('.course-label__code')).toHaveTextContent('MAT232');
    expect(withCode?.querySelector('.course-label__name')).toHaveTextContent('Calculus of Several Variables');
    expect(withoutCode?.querySelector('.course-label__code--name')).toHaveTextContent('线性代数');
  });

  it('draws tag dots and file icons in their palette colours', () => {
    const { container } = render(
      <>
        <TagDot color="blue" />
        <TagDot color="mauve" />
        <FileTypeIcon name="Lecture 7.PDF" />
        <FileTypeIcon name="data.bin" />
      </>,
    );
    const [blue, unknown] = container.querySelectorAll('.tag-dot');
    expect(blue).toHaveAttribute('data-palette', 'blue');
    expect(unknown).not.toHaveAttribute('data-palette');
    const [pdf, other] = container.querySelectorAll('.file-type-icon');
    expect(pdf).toHaveAttribute('data-palette', 'red');
    expect(other).not.toHaveAttribute('data-palette');
  });

  it('names each change status icon', () => {
    render(
      <>
        <ChangeStatusIcon status="added" />
        <ChangeStatusIcon status="modified" />
        <ChangeStatusIcon status="deleted" />
        <ChangeStatusIcon status="renamed" />
      </>,
    );
    for (const name of Object.values(common.changeStatus)) {
      expect(screen.getByRole('img', { name })).toBeInTheDocument();
    }
  });

  it('toggles tag chips with aria-pressed and removes tags with named buttons', async () => {
    const onRemove = vi.fn();
    function Filter() {
      const [on, setOn] = useState(false);
      return <TagToggle tag={{ name: 'Notes', color: 'blue' }} isSelected={on} onChange={setOn} />;
    }
    render(
      <>
        <Filter />
        <TagChipList label="Tags" tags={[{ id: 't1', name: 'Exams', color: 'red' }]} onRemove={onRemove} />
      </>,
    );
    const chip = screen.getByRole('button', { name: 'Notes' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag Exams' }));
    expect(onRemove).toHaveBeenCalledWith('t1');
  });

  it('formats counts and can name what they count', () => {
    render(
      <>
        <CountPill count={4210} />
        <CountPill count={12} label="12 files" />
      </>,
    );
    expect(screen.getByText('4,210')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '12 files' })).toHaveTextContent('12');
  });
});

describe('SegmentedControl', () => {
  it('presses one segment at a time and reports the choice', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Library view"
        selected="tree"
        onChange={onChange}
        segments={[
          { id: 'list', label: 'List', icon: List },
          { id: 'tree', label: 'Tree', icon: ListTree },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Library view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Tree' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(onChange).toHaveBeenCalledWith('list');
  });
});

describe('feedback', () => {
  it('shows a state block with its title, text, buttons and hint', () => {
    const { container } = render(
      <StateBlock
        tone="danger"
        icon={FolderOpen}
        title="Couldn't load your courses"
        text="Try again."
        actions={<Button>Try again</Button>}
        hint="Or switch semesters."
      />,
    );
    expect(screen.getByRole('heading', { name: "Couldn't load your courses" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByText('Or switch semesters.')).toBeInTheDocument();
    expect(container.querySelector('.state-block')).toHaveAttribute('data-tone', 'danger');
  });

  it('announces banners that appear after an action: danger as an alert, others as status', () => {
    const { rerender } = render(<Banner tone="danger" size="block" title="Folio couldn't check these files" announce />);
    expect(screen.getByRole('alert')).toHaveTextContent("Folio couldn't check these files");
    rerender(<Banner tone="warning" title="Read-only for now." text="Update Folio." announce />);
    expect(screen.getByRole('status')).toHaveTextContent('Read-only for now. Update Folio.');
    rerender(<Banner tone="info" title="Rebuilding the search index." />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lets a banner be dismissed', async () => {
    const onDismiss = vi.fn();
    render(<Banner tone="info" title="Folio rebuilt its index." onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: common.dismiss }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('gives field errors and callouts ids that fields point at, and alerts with callouts', () => {
    render(
      <>
        <input aria-describedby="field-error" aria-invalid="true" aria-label="Device name" />
        <FieldError id="field-error">Enter a name.</FieldError>
        <input aria-describedby="callout" aria-label="Name" />
        <Callout id="callout">A name can't end with a dot or a space.</Callout>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Device name' })).toHaveAccessibleDescription('Enter a name.');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAccessibleDescription(
      "A name can't end with a dot or a space.",
    );
    expect(screen.getByRole('alert')).toHaveTextContent("A name can't end with a dot or a space.");
  });
});

describe('progress', () => {
  it('reports a known value and leaves an unknown one out', () => {
    render(
      <>
        <ProgressBar label="Adding files" value={58} />
        <ProgressBar label="Rebuilding" value={null} />
      </>,
    );
    expect(screen.getByRole('progressbar', { name: 'Adding files' })).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByRole('progressbar', { name: 'Rebuilding' })).not.toHaveAttribute('aria-valuenow');
  });

  it('turns the ring only while the total is unknown', () => {
    const { container } = render(
      <>
        <ProgressRing value={38} />
        <ProgressRing value={null} />
      </>,
    );
    const [known, unknown] = container.querySelectorAll('.progress-ring');
    expect(known).not.toHaveClass('spinning');
    expect(unknown).toHaveClass('spinning');
  });
});

describe('Skeleton', () => {
  it('shows nothing for the first 150 ms, then loading rows', () => {
    vi.useFakeTimers();
    try {
      render(<Skeleton rows={3} />);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(LOADING_DELAY_MS);
      });
      expect(screen.getByRole('status', { name: common.loading })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Panel and MiddleTruncate', () => {
  it('names the panel region by its title', () => {
    render(
      <Panel title="Library" count={3}>
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'Library' })).toHaveTextContent('Body');
  });

  it('keeps the end of long text whole and the whole text in the title', () => {
    const text = 'MAT232/Problem sets/ps3-solutions.docx';
    const { container } = render(<MiddleTruncate text={text} />);
    expect(container.querySelector('.middle-truncate__tail')).toHaveTextContent('ps3-solutions.docx'.slice(-16));
    expect(container.querySelector('.middle-truncate')).toHaveAttribute('title', text);
    expect(container).toHaveTextContent(text);
  });
});
