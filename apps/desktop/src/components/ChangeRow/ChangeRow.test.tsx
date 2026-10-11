// The shared parts of a change row (workspace-history handoff §3.2–§3.4, §7.2) and the icon the
// diff header puts before its path.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { stylesheetsReading } from '../../test/stylesheets';
import sheet from './ChangeRow.css?raw';
import { ChangeRowIconView, ChangeRowParts } from './ChangeRow';
import type { ChangeRowFace, ChangeRowIcon } from './words';

const FACE: ChangeRowFace = {
  icon: { kind: 'tag' },
  path: { label: 'MAT232/', prefix: 'Problem sets/', name: 'ps2 solutions.md' },
  tooltip: 'MAT232/Problem sets/ps2 solutions.md\nMoved from MAT232/ps2.md',
  tagsTag: true,
  status: 'renamed',
  deleted: false,
};

describe('ChangeRowIconView', () => {
  const lucide: [Exclude<ChangeRowIcon['kind'], 'file'>, string][] = [
    ['folder', 'lucide-folder'],
    ['folderOpen', 'lucide-folder-open'],
    ['tag', 'lucide-tag'],
    ['settings', 'lucide-settings'],
    ['tags', 'lucide-tags'],
    ['fileCog', 'lucide-file-cog'],
  ];

  it.each(lucide)('draws %s as its Lucide icon', (kind, className) => {
    const { container } = render(<ChangeRowIconView icon={{ kind }} />);
    const icons = container.querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.classList).toContain(className);
  });

  it("draws a file as its type's icon", () => {
    const { container } = render(<ChangeRowIconView icon={{ kind: 'file', name: '期中 2025.pdf' }} />);
    const icon = container.querySelector('svg');
    expect(icon?.classList).toContain('file-type-icon');
    expect(icon?.classList).toContain('lucide-file-text');
  });
});

describe('ChangeRowParts', () => {
  it('renders the icon, the path, the tag, what the view adds and the status, with no element around them', () => {
    const { container } = render(
      <ChangeRowParts face={FACE}>
        <span className="view-count">2 changes</span>
      </ChangeRowParts>,
    );
    expect([...container.children].map((child) => child.className)).toEqual([
      'change-row__icon',
      'path-text',
      'change-row__tag',
      'view-count',
      'change-row__status',
    ]);
  });

  it('hides the icon from assistive technology', () => {
    const { container } = render(<ChangeRowParts face={FACE} />);
    const icon = container.querySelector('.change-row__icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.querySelector('svg')?.classList).toContain('lucide-tag');
  });

  it("shows the path's parts, with the face's tooltip", () => {
    const { container } = render(<ChangeRowParts face={FACE} />);
    const path = container.querySelector('.path-text');
    expect(path).toHaveTextContent('MAT232/Problem sets/ps2 solutions.md');
    expect(path).toHaveAttribute('title', FACE.tooltip);
    expect(path?.querySelector('.path-heading__label')).toHaveTextContent('MAT232/');
    expect(path?.querySelector('.path-heading__path')).toHaveTextContent('Problem sets/');
    expect(path?.querySelector('.path-heading__name')).toHaveTextContent('ps2 solutions.md');
  });

  it('shows the "Tags" tag of common only for a tag change', () => {
    const { container, rerender } = render(<ChangeRowParts face={FACE} />);
    expect(container.querySelector('.change-row__tag')).toHaveTextContent(/^Tags$/);
    rerender(<ChangeRowParts face={{ ...FACE, tagsTag: false }} />);
    expect(container.querySelector('.change-row__tag')).toBeNull();
  });

  it('ends with the status image, named by the change', () => {
    const { container } = render(<ChangeRowParts face={{ ...FACE, status: 'deleted' }} />);
    const status = container.querySelector('.change-row__status');
    expect(status).toBe(container.lastElementChild);
    expect(status).toContainElement(screen.getByRole('img', { name: 'Deleted' }));
  });

  it('keeps Chinese names whole', () => {
    const face: ChangeRowFace = {
      ...FACE,
      icon: { kind: 'file', name: '第一章.md' },
      path: { label: '', prefix: '线性代数/习题/', name: '第一章.md' },
      tooltip: '线性代数/习题/第一章.md',
      tagsTag: false,
    };
    const { container } = render(<ChangeRowParts face={face} />);
    expect(container.querySelector('.path-text')).toHaveTextContent('线性代数/习题/第一章.md');
    expect(container.querySelector('.path-heading__label')).toBeNull();
  });
});

describe('ChangeRow.css', () => {
  it('is the only stylesheet that draws the "Tags" tag', () => {
    // The Changes list and History's file cards each drew their own copy before; a new list of
    // changes renders `ChangeRowParts` instead of a third.
    expect(stylesheetsReading('--size-changes-tag')).toEqual(['/src/components/ChangeRow/ChangeRow.css']);
    expect(sheet).toMatch(/\.change-row__tag \{[^}]*height: var\(--size-changes-tag\)/);
  });
});
