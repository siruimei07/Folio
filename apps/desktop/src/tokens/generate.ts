// Turns the design tokens (design/tokens/*.tokens.json, DTCG format 2025.10) into the CSS custom
// properties of tokens.css, and the sizes that code needs as numbers into tokens.ts, as
// design/tokens/README.md specifies. Only the drift test in generate.test.ts runs it; tokens.css
// and tokens.ts are its committed output.

/** The three token files, parsed. */
export interface TokenFiles {
  base: unknown;
  light: unknown;
  dark: unknown;
}

type Fail = (message: string) => never;

type Convert = (value: unknown, at: Fail) => string;

interface Token {
  file: string;
  path: string;
  type: string;
  value: unknown;
  convert: Convert;
}

type Tokens = Map<string, Token>;

/** One converter per supported `$type` (README "Naming and CSS output"). */
const CONVERTERS: Record<string, Convert> = {
  color,
  cubicBezier,
  dimension: (value, at) => measure(value, ['px', 'rem'], at),
  duration: (value, at) => measure(value, ['ms'], at),
  fontFamily,
  fontWeight: (value, at) => plainNumber(value, at, 1, 1000),
  number: (value, at) => plainNumber(value, at),
  shadow,
};

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'math',
  'emoji',
]);

/** One path segment: lower-case words joined by single hyphens, so every CSS name is plain. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ALIAS = /^\{([^{}]+)\}$/;

const BASE_FILE = 'base.tokens.json';
const LIGHT_FILE = 'color.light.tokens.json';
const DARK_FILE = 'color.dark.tokens.json';

/** Builds tokens.css. Throws on anything the README does not allow, naming the file and token. */
export function generateTokensCss(files: TokenFiles): string {
  const base = collect(BASE_FILE, files.base);
  const light = collect(LIGHT_FILE, files.light);
  const dark = collect(DARK_FILE, files.dark);
  checkModes(light, dark);
  checkNames(base, light);

  const lightScope = new Map([...base, ...light]);
  const darkScope = new Map([...base, ...dark]);
  const durations = [...lightScope.values()].filter((token) => token.type === 'duration');
  const zeroDurations = durations.map((token) => `${cssName(token.path)}: 0ms;`);
  const darkDeclarations = declarations(dark, darkScope);

  return [
    '/*',
    ' * Generated from design/tokens/*.tokens.json by src/tokens/generate.ts. Do not edit: change the',
    ' * tokens, then run `pnpm --filter @folio/desktop tokens` (design/tokens/README.md).',
    ' */',
    '',
    rule(':root', ['color-scheme: light;', ...declarations(lightScope, lightScope)]),
    '',
    '/* Theme "Dark", or "System" while Windows uses dark mode. */',
    rule(':root[data-theme="dark"]', ['color-scheme: dark;', ...darkDeclarations]),
    '',
    '@media (prefers-color-scheme: dark) {',
    indent(rule(':root:not([data-theme="light"])', ['color-scheme: dark;', ...darkDeclarations])),
    '}',
    '',
    '/* Reduce motion "On", or "Use Windows setting" while Windows turns animations off. */',
    rule(':root[data-reduce-motion="on"]', zeroDurations),
    '',
    '@media (prefers-reduced-motion: reduce) {',
    indent(rule(':root:not([data-reduce-motion="off"])', zeroDurations)),
    '}',
    '',
  ].join('\n');
}

/**
 * Builds tokens.ts: every `size.*` and `space.*` token as a number of CSS pixels, for code that
 * cannot read custom properties (media queries, virtualisers, overlay offsets; UI architecture
 * §6.3). Throws like `generateTokensCss`, and on a value that is not in px.
 */
export function generateTokensTs(files: Pick<TokenFiles, 'base'>): string {
  const base = collect(BASE_FILE, files.base);
  const group = (name: string, doc: string) => {
    const entries = [...base.values()]
      .filter((token) => token.path.startsWith(`${name}.`))
      .map((token) => {
        const at: Fail = (message) => fail(token.file, token.path, message);
        const value = resolve(token, base);
        if (value.type !== 'dimension') return at(`is a ${value.type}, not a dimension`);
        if (!isRecord(value.value) || value.value.unit !== 'px' || !isFiniteNumber(value.value.value)) {
          return at('needs a px value to become a number');
        }
        return `  ${camelCase(token.path.slice(name.length + 1))}: ${String(value.value.value)},`;
      });
    return [`/** ${doc} */`, `export const ${name.toUpperCase()} = {`, ...entries, '} as const;'];
  };
  return [
    '// Generated from design/tokens/base.tokens.json by src/tokens/generate.ts. Do not edit: change',
    '// the tokens, then run `pnpm --filter @folio/desktop tokens` (design/tokens/README.md).',
    '',
    ...group('size', 'The `size.*` tokens in CSS pixels, for code that cannot read custom properties.'),
    '',
    ...group('space', 'The `space.*` tokens in CSS pixels, for overlay offsets and other code.'),
    '',
  ].join('\n');
}

/** The token an alias chain ends at; the token itself when it is no alias. */
function resolve(token: Token, scope: Tokens): Token {
  const first = aliasOf(token.value);
  return first === undefined ? token : checkAlias(token, first, scope);
}

function camelCase(name: string): string {
  return name.replace(/[-.]([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

function collect(file: string, tree: unknown): Tokens {
  const tokens: Tokens = new Map();
  const visit = (node: unknown, path: string[]): void => {
    const where = path.join('.');
    if (!isRecord(node)) fail(file, where, 'is neither a group nor a token');
    if ('$value' in node) {
      if (path.length === 0) fail(file, where, 'the file itself cannot be a token');
      const type = node.$type;
      const convert = typeof type === 'string' && Object.hasOwn(CONVERTERS, type) ? CONVERTERS[type] : undefined;
      if (typeof type !== 'string' || !convert) fail(file, where, `has an unsupported $type ${JSON.stringify(type)}`);
      tokens.set(where, { file, path: where, type, value: node.$value, convert });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      if (!SEGMENT.test(key)) fail(file, [...path, key].join('.'), 'is not a lower-case kebab name');
      visit(child, [...path, key]);
    }
  };
  visit(tree, []);
  return tokens;
}

/** Both colour files must define the same paths with the same types (README "Files"). */
function checkModes(light: Tokens, dark: Tokens): void {
  for (const [path, token] of light) {
    const other = dark.get(path);
    if (!other) fail(LIGHT_FILE, path, `is missing from ${DARK_FILE}`);
    if (other.type !== token.type) fail(DARK_FILE, path, `is a ${other.type}, not a ${token.type}`);
  }
  for (const path of dark.keys()) {
    if (!light.has(path)) fail(DARK_FILE, path, `is missing from ${LIGHT_FILE}`);
  }
}

/** Joining a path with "-" must give each token its own CSS name. */
function checkNames(base: Tokens, colors: Tokens): void {
  const names = new Map<string, Token>();
  for (const token of [...base.values(), ...colors.values()]) {
    const name = cssName(token.path);
    const other = names.get(name);
    if (other) fail(token.file, token.path, `has the same CSS name ${name} as ${other.path} in ${other.file}`);
    names.set(name, token);
  }
}

function declarations(tokens: Tokens, scope: Tokens): string[] {
  return [...tokens.values()].map((token) => `${cssName(token.path)}: ${cssValue(token, scope)};`);
}

function cssValue(token: Token, scope: Tokens): string {
  const target = aliasOf(token.value);
  if (target === undefined) return token.convert(token.value, (message) => fail(token.file, token.path, message));
  checkAlias(token, target, scope);
  return `var(${cssName(target)})`;
}

/**
 * An alias must lead, possibly through other aliases, to a value of its own type. Returns the
 * token the chain ends at.
 */
function checkAlias(token: Token, first: string, scope: Tokens): Token {
  const seen = new Set([token.path]);
  let target = first;
  for (;;) {
    const next = scope.get(target);
    if (!next) return fail(token.file, token.path, `refers to {${target}}, which does not exist`);
    if (next.type !== token.type) fail(token.file, token.path, `refers to {${target}}, a ${next.type}`);
    if (seen.has(target)) fail(token.file, token.path, `is part of an alias cycle through {${target}}`);
    seen.add(target);
    const following = aliasOf(next.value);
    if (following === undefined) return next;
    target = following;
  }
}

function aliasOf(value: unknown): string | undefined {
  return typeof value === 'string' ? ALIAS.exec(value)?.[1] : undefined;
}

function color(value: unknown, at: Fail): string {
  if (!isRecord(value) || value.colorSpace !== 'srgb') return at('needs an srgb colour object');
  const { components, alpha, hex } = value;
  if (!isNumberList(components, 3) || components.some((c) => c < 0 || c > 1)) {
    return at('needs three components between 0 and 1');
  }
  const bytes = components.map((c) => Math.round(c * 255));
  const exact = `#${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (hex !== undefined && (typeof hex !== 'string' || hex.toLowerCase() !== exact)) {
    return at(`has hex ${JSON.stringify(hex)}, but its components give ${exact}`);
  }
  if (alpha === undefined || alpha === 1) return exact;
  if (typeof alpha !== 'number' || alpha < 0 || alpha > 1) return at('needs an alpha between 0 and 1');
  return `rgb(${bytes.join(' ')} / ${String(alpha)})`;
}

function measure(value: unknown, units: string[], at: Fail): string {
  if (!isRecord(value) || !isFiniteNumber(value.value) || typeof value.unit !== 'string') {
    return at('needs { value, unit }');
  }
  if (!units.includes(value.unit)) return at(`needs one of the units ${units.join(', ')}`);
  return `${String(value.value)}${value.unit}`;
}

function cubicBezier(value: unknown, at: Fail): string {
  if (!isNumberList(value, 4)) return at('needs four numbers');
  if (value.some((n, i) => i % 2 === 0 && (n < 0 || n > 1))) return at('needs x values between 0 and 1');
  return `cubic-bezier(${value.join(', ')})`;
}

function shadow(value: unknown, at: Fail): string {
  const layers = Array.isArray(value) ? (value as unknown[]) : [value];
  if (layers.length === 0) return at('needs at least one layer');
  return layers
    .map((layer) => {
      if (!isRecord(layer)) return at('needs shadow layer objects');
      if (layer.inset !== undefined && typeof layer.inset !== 'boolean') return at('needs a boolean inset');
      const parts = [layer.offsetX, layer.offsetY, layer.blur, layer.spread].map((part) =>
        measure(part, ['px', 'rem'], at),
      );
      return [...(layer.inset === true ? ['inset'] : []), ...parts, color(layer.color, at)].join(' ');
    })
    .join(', ');
}

function fontFamily(value: unknown, at: Fail): string {
  const names = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(names) || names.length === 0) return at('needs a name or a list of names');
  return names
    .map((name: unknown) => {
      if (typeof name !== 'string' || name === '' || /["\\\n]/.test(name)) return at('has an unusable font name');
      return GENERIC_FAMILIES.has(name) ? name : `"${name}"`;
    })
    .join(', ');
}

function plainNumber(value: unknown, at: Fail, min = -Infinity, max = Infinity): string {
  if (!isFiniteNumber(value) || value < min || value > max) return at('needs a number in range');
  return String(value);
}

function rule(selector: string, lines: string[]): string {
  return [`${selector} {`, indent(lines.join('\n')), '}'].join('\n');
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function cssName(path: string): string {
  return `--${path.replaceAll('.', '-')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberList(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function fail(file: string, path: string, message: string): never {
  throw new Error(`${file}: ${path === '' ? '(root)' : path} ${message}`);
}
