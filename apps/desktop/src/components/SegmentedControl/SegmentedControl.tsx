import './SegmentedControl.css';

import type { LucideIcon } from 'lucide-react';
import type { Key } from 'react-aria-components';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';

import { SIZE } from '../../tokens/tokens';
import { Tooltip } from '../Tooltip/Tooltip';

export interface Segment<K extends Key> {
  id: K;
  label: string;
  /** With an icon the segment shows only the icon, and its label in a tooltip. */
  icon?: LucideIcon;
}

export interface SegmentedControlProps<K extends Key> {
  /** Names the group, like "Library view". */
  label: string;
  segments: readonly Segment<K>[];
  selected: K;
  onChange: (id: K) => void;
}

/**
 * One choice among a few, as pressed segments on a sunken track: List / Tree, List / Grid,
 * Changes / This version (app-shell handoff §10).
 */
export function SegmentedControl<K extends Key>({ label, segments, selected, onChange }: SegmentedControlProps<K>) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      className="segmented-control"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        const segment = segments.find(({ id }) => id === next);
        if (segment) onChange(segment.id);
      }}
    >
      {segments.map(({ id, label: segmentLabel, icon: Icon }) =>
        Icon ? (
          <Tooltip key={id} content={segmentLabel}>
            <ToggleButton id={id} aria-label={segmentLabel} className="segmented-control__segment" data-icon>
              <Icon aria-hidden size={SIZE.iconSmall} />
            </ToggleButton>
          </Tooltip>
        ) : (
          <ToggleButton key={id} id={id} className="segmented-control__segment">
            {segmentLabel}
          </ToggleButton>
        ),
      )}
    </ToggleButtonGroup>
  );
}
