// The ten named colours of courses and tags (ADR-0002; design/tokens/README.md "Palette usage").
// Each has the tokens palette.<name>.tint, .text, .dot and .solid in both modes.

/** In the order first-run handoff §1 gives new courses their colours. */
export const PALETTE = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
  'stone',
] as const;

export type PaletteColor = (typeof PALETTE)[number];

export function isPaletteColor(value: string): value is PaletteColor {
  return (PALETTE as readonly string[]).includes(value);
}
