// The four feedback tones and their icons (design/tokens/README.md "Feedback colours";
// library-actions handoff §2.3). Colour is never the only cue: each tone has its icon and words.
// tone.css gives an element with data-tone its colours.

import { CircleCheck, CircleX, Info, type LucideIcon, TriangleAlert } from 'lucide-react';

import { SIZE } from '../tokens/tokens';

export type Tone = 'danger' | 'warning' | 'success' | 'info';

export const TONE_ICONS: Readonly<Record<Tone, LucideIcon>> = {
  danger: CircleX,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
};

export interface ToneIconProps {
  tone: Tone;
  size?: 'small' | 'regular';
  className?: string;
}

/** A tone's icon in the tone's colour (with tone.css loaded); decorative, the words say it. */
export function ToneIcon({ tone, size = 'regular', className }: ToneIconProps) {
  const Icon = TONE_ICONS[tone];
  return (
    <Icon
      aria-hidden
      data-tone={tone}
      className={className}
      size={size === 'small' ? SIZE.iconSmall : SIZE.icon}
    />
  );
}
