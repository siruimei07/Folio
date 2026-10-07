import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CountPill } from './CountPill';

describe('CountPill', () => {
  it('writes a number with the thousands separators of the UI language', () => {
    render(<CountPill count={50000} label="50,000 changes" />);
    expect(screen.getByRole('img', { name: '50,000 changes' })).toHaveTextContent('50,000');
  });

  it('shows a placeholder as it is while the count loads or is unknown', () => {
    const { container, rerender } = render(<CountPill count="…" />);
    expect(container.querySelector('.count-pill')).toHaveTextContent('…');
    rerender(<CountPill count="–" label="Number of changes unknown" />);
    expect(screen.getByRole('img', { name: 'Number of changes unknown' })).toHaveTextContent('–');
  });
});
