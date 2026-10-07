// The shared selection bar (workspace-history handoff §8.6): one component and one stylesheet for
// the tree, the lists, search, the settings nav and the rail.
import { render, screen } from '@testing-library/react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { describe, expect, it } from 'vitest';

import sheet from './SelectionIndicator.css?raw';
import { SelectionIndicator } from './SelectionIndicator';

/** The rule that lays the bar along the bottom of a tab in a horizontal tab list. */
const HORIZONTAL_TAB = ".selection-indicator[data-placement='tab']";
const HORIZONTAL_LIST = "[role='tablist'][data-orientation='horizontal']";

function NavTabs({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  return (
    <Tabs orientation={orientation} defaultSelectedKey="general">
      <TabList aria-label="Pages">
        {['general', 'courses'].map((id) => (
          <Tab key={id} id={id}>
            {({ isSelected }) => (
              <>
                {isSelected && <SelectionIndicator placement="tab" />}
                {id}
              </>
            )}
          </Tab>
        ))}
      </TabList>
      <TabPanel id="general">General</TabPanel>
      <TabPanel id="courses">Courses</TabPanel>
    </Tabs>
  );
}

describe('SelectionIndicator', () => {
  it('is a bar hidden from assistive technology, at a row by default, at the edge or on a tab', () => {
    const { container } = render(
      <>
        <SelectionIndicator />
        <SelectionIndicator placement="edge" />
        <SelectionIndicator placement="tab" />
      </>,
    );
    const bars = [...container.querySelectorAll('.selection-indicator')];
    expect(bars.map((bar) => bar.getAttribute('data-placement'))).toEqual(['row', 'edge', 'tab']);
    for (const bar of bars) expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(container).toHaveTextContent('');
  });

  it('follows its tab list: along the bottom while it is horizontal, at the side while it is vertical', () => {
    expect(sheet).toContain(`${HORIZONTAL_LIST} ${HORIZONTAL_TAB}`);
    const { container, unmount } = render(<NavTabs orientation="horizontal" />);
    expect(screen.getByRole('tab', { name: 'general' })).toHaveAttribute('aria-selected', 'true');
    const bars = container.querySelectorAll('.selection-indicator');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.matches(`${HORIZONTAL_LIST} ${HORIZONTAL_TAB}`)).toBe(true);
    unmount();
    const vertical = render(<NavTabs orientation="vertical" />);
    expect(vertical.container.querySelector('.selection-indicator')?.matches(`${HORIZONTAL_LIST} ${HORIZONTAL_TAB}`)).toBe(
      false,
    );
  });

  it('is the only stylesheet that draws a selection bar', () => {
    // The tree, search, the settings nav and the rail each drew their own copy before; a new list
    // renders the component instead of a sixth.
    const sheets = import.meta.glob<string>('/src/**/*.css', { query: '?raw', import: 'default', eager: true });
    const drawing = Object.entries(sheets)
      .filter(([, text]) => /var\(\s*--size-selection-bar-(width|inset)\b/.test(text))
      .map(([file]) => file);
    expect(drawing).toEqual(['/src/components/SelectionIndicator/SelectionIndicator.css']);
    // 3 px of the indicator colour, inset top and bottom, rounded on the right.
    expect(sheet).toMatch(/width: var\(--size-selection-bar-width\)/);
    expect(sheet).toMatch(/top: var\(--size-selection-bar-inset\)/);
    expect(sheet).toMatch(/border-radius: 0 var\(--radius-indicator\) var\(--radius-indicator\) 0/);
    expect(sheet).toMatch(/background: var\(--color-selection-indicator\)/);
  });
});
