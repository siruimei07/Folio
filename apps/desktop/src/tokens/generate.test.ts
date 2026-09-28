import { describe, expect, it } from 'vitest';

import base from '../../../../design/tokens/base.tokens.json';
import dark from '../../../../design/tokens/color.dark.tokens.json';
import light from '../../../../design/tokens/color.light.tokens.json';
import { generateTokensCss, type TokenFiles } from './generate';

describe('tokens.css', () => {
  it('is the current output of design/tokens', async () => {
    // Fails when tokens.css is stale; `pnpm --filter @folio/desktop tokens` rewrites it.
    await expect(generateTokensCss({ base, light, dark })).toMatchFileSnapshot('./tokens.css');
  });

  it('defines every custom property that the stylesheets read', () => {
    const sheets = import.meta.glob<string>('/src/**/*.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const text = Object.values(sheets).join('\n');
    const defined = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const read = Object.entries(sheets).flatMap(([file, sheet]) =>
      [...sheet.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => ({ file, name: match[1] })),
    );
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter(({ name }) => !defined.has(name))).toEqual([]);
  });
});

const srgb = (components: number[], extra: Record<string, unknown> = {}) => ({
  $type: 'color',
  $value: { colorSpace: 'srgb', components, ...extra },
});
const px = (value: number) => ({ $type: 'dimension', $value: { value, unit: 'px' } });

function files(changes: Partial<TokenFiles> = {}): TokenFiles {
  const colors = (accent: number[]) => ({
    color: {
      accent: srgb(accent),
      indicator: { $type: 'color', $value: '{color.accent}' },
      scrim: srgb([0.1098, 0.098, 0.0902], { alpha: 0.24, hex: '#1c1917' }),
    },
  });
  return {
    base: {
      $description: 'Group descriptions are skipped.',
      space: { '8': px(8), gap: { $type: 'dimension', $value: '{space.8}' } },
      font: {
        family: { $type: 'fontFamily', $value: ['Segoe UI', 'sans-serif'] },
        weight: { $type: 'fontWeight', $value: 600 },
        'line-height': { $type: 'number', $value: 1.45 },
      },
      motion: {
        fast: { $type: 'duration', $value: { value: 120, unit: 'ms' } },
        ease: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] },
      },
      shadow: {
        $type: 'shadow',
        $value: [
          {
            color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.16 },
            offsetX: { value: 0, unit: 'px' },
            offsetY: { value: 18, unit: 'px' },
            blur: { value: 44, unit: 'px' },
            spread: { value: 0, unit: 'px' },
          },
        ],
      },
    },
    light: colors([1, 1, 1]),
    dark: colors([0, 0, 0]),
    ...changes,
  };
}

describe('generateTokensCss', () => {
  it('writes light values in :root, dark values for the dark themes, and 0 ms for reduced motion', () => {
    expect(generateTokensCss(files())).toMatchInlineSnapshot(`
      "/*
       * Generated from design/tokens/*.tokens.json by src/tokens/generate.ts. Do not edit: change the
       * tokens, then run \`pnpm --filter @folio/desktop tokens\` (design/tokens/README.md).
       */

      :root {
        color-scheme: light;
        --space-8: 8px;
        --space-gap: var(--space-8);
        --font-family: "Segoe UI", sans-serif;
        --font-weight: 600;
        --font-line-height: 1.45;
        --motion-fast: 120ms;
        --motion-ease: cubic-bezier(0.2, 0, 0, 1);
        --shadow: 0px 18px 44px 0px rgb(0 0 0 / 0.16);
        --color-accent: #ffffff;
        --color-indicator: var(--color-accent);
        --color-scrim: rgb(28 25 23 / 0.24);
      }

      /* Theme "Dark", or "System" while Windows uses dark mode. */
      :root[data-theme="dark"] {
        color-scheme: dark;
        --color-accent: #000000;
        --color-indicator: var(--color-accent);
        --color-scrim: rgb(28 25 23 / 0.24);
      }

      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          color-scheme: dark;
          --color-accent: #000000;
          --color-indicator: var(--color-accent);
          --color-scrim: rgb(28 25 23 / 0.24);
        }
      }

      /* Reduce motion "On", or "Use Windows setting" while Windows turns animations off. */
      :root[data-reduce-motion="on"] {
        --motion-fast: 0ms;
      }

      @media (prefers-reduced-motion: reduce) {
        :root:not([data-reduce-motion="off"]) {
          --motion-fast: 0ms;
        }
      }
      "
    `);
  });

  it.each([
    ['a colour missing from dark mode', { dark: { color: {} } }, /color\.accent is missing from color\.dark/],
    [
      'an alias to a missing token',
      { base: { a: { $type: 'color', $value: '{color.none}' } } },
      /refers to \{color\.none\}, which does not exist/,
    ],
    [
      'an alias to a token of another type',
      { base: { space: { a: px(1), b: { $type: 'color', $value: '{space.a}' } } } },
      /refers to \{space\.a\}, a dimension/,
    ],
    [
      'an alias cycle',
      {
        base: {
          a: { $type: 'number', $value: '{b}' },
          b: { $type: 'number', $value: '{a}' },
        },
      },
      /alias cycle/,
    ],
    [
      'a hex fallback that differs from the components',
      { base: { tint: srgb([1, 1, 1], { hex: '#fefefe' }) } },
      /has hex "#fefefe", but its components give #ffffff/,
    ],
    ['two paths with one CSS name', { base: { a: { 'b-c': px(1), b: { c: px(2) } } } }, /same CSS name --a-b-c/],
    ['a token without a type', { base: { a: { $value: 1 } } }, /unsupported \$type undefined/],
    ['an unknown unit', { base: { a: { $type: 'dimension', $value: { value: 1, unit: 'em' } } } }, /units px, rem/],
    ['a name that is not kebab case', { base: { Space: px(1) } }, /Space is not a lower-case kebab name/],
  ])('rejects %s', (_, changes, message) => {
    expect(() => generateTokensCss(files(changes))).toThrow(message);
  });
});
