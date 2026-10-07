// The path heading of the diff and preview panes (workspace-history handoff §3.2, §6.1; app-shell
// 27B): the course code stays whole, apart from the folders that the ellipsis cuts first.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Course } from '../../ipc';
import { headingPrefix } from '../../lib/places';
import { PathHeading, PathText } from './PathHeading';

function course(path: string, code: string | null, name: string): Course {
  return { folder: { id: path, path }, name, abbr: null, code, color: null, archived: false, files: 0 };
}

const MAT = course('Fall 2026/MAT232 Calculus of Several Variables', 'MAT232', 'MAT232 Calculus of Several Variables');
const LINEAR = course('Fall 2026/线性代数', null, '线性代数');

describe('headingPrefix', () => {
  it('splits the course code from the folders below it', () => {
    expect(headingPrefix(`${MAT.folder.path}/Exams/Midterm`, [MAT, LINEAR])).toEqual({ label: 'MAT232/', folders: 'Exams/Midterm/' });
    expect(headingPrefix(MAT.folder.path, [MAT])).toEqual({ label: 'MAT232/', folders: '' });
  });

  it('keeps a course without a code with the folders, which it shrinks with', () => {
    expect(headingPrefix(`${LINEAR.folder.path}/习题`, [MAT, LINEAR])).toEqual({ label: '', folders: '线性代数/习题/' });
  });

  it('has only folders outside the courses, and nothing at the top', () => {
    expect(headingPrefix('Personal/Photos', [MAT])).toEqual({ label: '', folders: 'Personal/Photos/' });
    expect(headingPrefix('', [MAT])).toEqual({ label: '', folders: '' });
  });
});

describe('PathHeading', () => {
  it('puts the code apart from the folders, which are cut from the left, and the whole path in its tooltip', () => {
    render(<PathHeading icon={null} label="MAT232/" prefix="Exams/Midterm/" name="Midterm 2025.pdf" suffix=" · Tags" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('MAT232/Exams/Midterm/Midterm 2025.pdf · Tags');
    expect(heading).toHaveAttribute('title', 'MAT232/Exams/Midterm/Midterm 2025.pdf · Tags');
    const label = heading.querySelector('.path-heading__label');
    const folders = heading.querySelector('.path-heading__path');
    expect(label).toHaveTextContent(/^MAT232\/$/);
    expect(folders).toHaveTextContent(/^Exams\/Midterm\/$/);
    // The code is not in the span the ellipsis cuts, and comes before it.
    expect(folders?.contains(label ?? null)).toBe(false);
    expect(label?.compareDocumentPosition(folders as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows neither without them', () => {
    render(<PathHeading icon={null} prefix="" name="Library settings" />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Library settings' });
    expect(heading.querySelector('.path-heading__label, .path-heading__path')).toBeNull();
  });
});

describe('PathText', () => {
  it("cuts a row's path as the heading does, with no heading, and the whole path in its tooltip", () => {
    const { container } = render(<PathText label="MAT232/" prefix="Problem sets/" name="ps2 solutions.md" />);
    expect(screen.queryByRole('heading')).toBeNull();
    const path = container.querySelector('.path-text');
    expect(path).toHaveAttribute('title', 'MAT232/Problem sets/ps2 solutions.md');
    expect(path?.querySelector('.path-heading__label')).toHaveTextContent(/^MAT232\/$/);
    expect(path?.querySelector('.path-heading__path')).toHaveTextContent(/^Problem sets\/$/);
    expect(path?.querySelector('.path-heading__name')).toHaveTextContent('ps2 solutions.md');
  });
});
