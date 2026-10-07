import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from '../Checkbox/Checkbox';
import { Panel } from './Panel';

describe('Panel', () => {
  it('puts what it leads with before the title, which names the region', () => {
    const { container } = render(
      <Panel
        title="Changes"
        leading={<Checkbox aria-label="Include all changes" isSelected onChange={vi.fn()} />}
        count="…"
        countLabel="Loading"
      >
        <p>Rows</p>
      </Panel>,
    );
    const region = screen.getByRole('region', { name: 'Changes' });
    const header = container.querySelector('.panel__header');
    expect(header).toHaveAttribute('data-leading');
    // The check box, then the title, then the count.
    const parts = [...(header?.children ?? [])];
    expect(parts[0]).toContainElement(screen.getByRole('checkbox', { name: 'Include all changes' }));
    expect(parts[1]).toHaveTextContent('Changes');
    expect(within(region).getByRole('img', { name: 'Loading' })).toHaveTextContent('…');
  });

  it('starts its header at the usual padding without anything before the title', () => {
    const { container } = render(
      <Panel title="Library" count={3}>
        <p>Rows</p>
      </Panel>,
    );
    expect(container.querySelector('.panel__header')).not.toHaveAttribute('data-leading');
  });
});
