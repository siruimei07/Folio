# Folio design tokens

The only source of visual values for the Folio UI (CLAUDE.md section 5). Components read CSS custom
properties generated from these files; they never hard-code colours, sizes, radii, font sizes or
durations.

- Status: v1, 2026-09-27. Derived from the Cowork design canvas "Folio 设计基础" (decisions 1-27,
  summarised in `docs/design/handoff/app-shell.md`). Round 3 added `font.size.label` (26C),
  `font.line-height.diff` and `font.line-height.heading`.
- The same tokens, with component previews, are in the Cowork Design System artifact
  "Folio Design System" (<https://claude.ai/artifact/QfXvWuzvoGdhUZCU4tsZyM>); these files stay the
  source of truth.

## Files

| File | Contents |
|---|---|
| `base.tokens.json` | Mode-independent tokens: font, space, size, radius, border, focus ring, title bar, caption buttons, motion, z-index |
| `color.light.tokens.json` | Light mode: semantic colours, course and tag palette, caption colours, overlay shadow |
| `color.dark.tokens.json` | Dark mode: the same token paths with dark values |

Format: [Design Tokens Community Group format 2025.10](https://www.designtokens.org/tr/drafts/format/).
Colours are objects (`colorSpace`, `components`, optional `alpha`, and a `hex` fallback);
dimensions and durations are `{ "value", "unit" }`; easings are `cubicBezier` arrays; aliases use
`{group.token}`. Both colour files must keep identical token paths.

## Naming and CSS output

CSS name = `--` + token path joined with `-`:

| Token path | CSS custom property |
|---|---|
| `color.text.tertiary` | `--color-text-tertiary` |
| `palette.blue.tint` | `--palette-blue-tint` |
| `size.history-panel` | `--size-history-panel` |
| `title-bar.height` | `--title-bar-height` |

The placeholder properties in `apps/desktop/src/base.css` keep their names (`--title-bar-height`,
`--title-bar-padding-inline`, `--title-bar-font-size`, `--caption-button-width`,
`--caption-glyph-size`, `--caption-button-hover-background`, `--caption-button-pressed-background`,
`--caption-close-hover-background`, `--caption-close-hover-color`, `--focus-ring-width`), so the
generated CSS replaces that block without touching the title bar components.

Value conversion:

| `$type` | CSS |
|---|---|
| `color` | `hex`, or `rgb(r g b / alpha)` when `alpha` is present |
| `dimension` | `<value><unit>` (for example `32px`) |
| `duration` | `<value>ms` |
| `cubicBezier` | `cubic-bezier(a, b, c, d)` |
| `shadow` | layers joined with commas: `<offsetX> <offsetY> <blur> <spread> <color>` |
| `fontFamily` | names quoted where needed, joined with commas |
| `fontWeight`, `number` | the number |

Engineering follow-up (Claude Code): add a small generator that emits one CSS file with light values
in `:root` and dark values under `:root[data-theme="dark"]`, run it from the build and from
`pnpm check` (fail when the output is stale, like `export_bindings`), and check that the two colour
files have the same paths. Do not hand-edit the generated CSS.

## Modes

App settings → Appearance → Theme offers Light, Dark and System (default System). System follows
`prefers-color-scheme`; the app sets `data-theme` on the root element.

## Motion

Two durations (`motion.duration.fast` 120 ms, `motion.duration.base` 160 ms) and two easings. When
`prefers-reduced-motion: reduce` matches, or the app setting "Reduce motion" is on, the generated
CSS sets every duration to `0ms`. Components must take durations only from these tokens.

## Palette usage

Courses and tags store a colour name (ADR-0002, for example `"color": "blue"`). Each of the ten
names has four roles per mode:

| Role | Used for |
|---|---|
| `palette.<name>.tint` | Course badge background (23A) |
| `palette.<name>.text` | Course badge text; three letters at `font.size.badge` |
| `palette.<name>.dot` | Tag dots in rows, tag chips, colour swatches in settings |
| `palette.<name>.solid` | File-type icons (14B) |

File type → palette colour: PDF red, Word blue, PowerPoint orange, Excel green, Markdown indigo,
code violet, images teal, audio and video pink, archives amber, plain text stone.

Below `size.badge-compact` (20 px) a course badge shows only a `dot`-coloured square with no text.

## Change status icons (20A)

16 × 16 viewBox, outlined square `x=1.75 y=1.75 w=12.5 h=12.5 rx=3`, stroke 1.25 in the status
colour, no fill; glyph stroke 1.5 with round caps in the same colour.

| Status | Colour token | Glyph path |
|---|---|---|
| Added | `color.status.added` | `M8 5v6M5 8h6` |
| Modified | `color.status.modified` | `M5.5 10.5l5-5` |
| Deleted | `color.status.deleted` | `M5 8h6` |
| Renamed | `color.status.renamed` | `M4.5 8h6.5M8.5 5.5L11 8l-2.5 2.5` |

## Contrast (WCAG 2.1 AA)

Checked against the values in these files. Text needs 4.5:1; UI parts and graphics need 3:1.

| Pair | Needs | Light | Dark |
|---|---|---|---|
| Primary text on panel | 4.5:1 | 17.49 | 14.32 |
| Secondary text on app background | 4.5:1 | 6.82 | 9.24 |
| Tertiary text on panel | 4.5:1 | 5.56 | 5.83 |
| Tertiary text on selected row | 4.5:1 | 4.75 | 4.83 |
| Tertiary text on hover | 4.5:1 | 4.98 | 5.36 |
| Tertiary text on sunken | 4.5:1 | 5.15 | 6.14 |
| Accent text on accent-soft (Not synced pill) | 4.5:1 | 4.59 | 6.34 |
| Text on accent button | 4.5:1 | 5.47 | 6.17 |
| Text on primary button | 4.5:1 | 14.76 | 14.75 |
| Diff + sign on added line | 4.5:1 | 4.85 | 10.88 |
| Diff - sign on removed line | 4.5:1 | 5.66 | 8.39 |
| Text on search highlight | 4.5:1 | 14.04 | 7.40 |
| Selection indicator on selected row | 3.0:1 | 4.67 | 6.67 |
| Focus ring on app background | 3.0:1 | 4.89 | 8.79 |
| Input bottom border on panel | 3.0:1 | 3.73 | 4.55 |
| Switch (off) on panel | 3.0:1 | 3.73 | 4.55 |
| Status: modified on selected row (lowest status pair) | 3.0:1 | 3.11 | 7.15 |
| Status: added on panel | 3.0:1 | 4.02 | 8.94 |
| Palette text on tint (course badge), lowest of 10 | 4.5:1 | 6.20 | 8.47 |
| Palette solid on panel (file-type icons), lowest of 10 | 3.0:1 | 3.75 | 7.62 |

`color.accent.fill` and `color.border.control` are decorative and are not used for indicators or
input boundaries: outline buttons and chips are identified by their text labels.
