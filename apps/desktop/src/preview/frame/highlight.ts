// Syntax highlighting with lowlight (UI architecture §10.4): highlight.js grammars produce a
// syntax tree, and the frame builds `<span>`s from it with text nodes only, so highlighted content
// is never parsed as HTML. The language always comes from the extension or a Markdown fence,
// never from auto-detection.

import type { Element, Root } from 'hast';
import type { LanguageFn } from 'highlight.js';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

/** Grammars outside lowlight's common set that course files need, loaded on first use. */
const EXTRA: Readonly<Record<string, () => Promise<{ default: LanguageFn }>>> = {
  cmake: () => import('highlight.js/lib/languages/cmake'),
  dart: () => import('highlight.js/lib/languages/dart'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  gradle: () => import('highlight.js/lib/languages/gradle'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  julia: () => import('highlight.js/lib/languages/julia'),
  latex: () => import('highlight.js/lib/languages/latex'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  scala: () => import('highlight.js/lib/languages/scala'),
  verilog: () => import('highlight.js/lib/languages/verilog'),
  vhdl: () => import('highlight.js/lib/languages/vhdl'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
};

/**
 * Fence names lowlight does not resolve itself: aliases of grammars that load on demand, and
 * `shell`, which highlight.js reads as a console session rather than a script.
 */
const ALIASES: Readonly<Record<string, string>> = {
  shell: 'bash',
  tex: 'latex',
  m: 'matlab',
  ps1: 'powershell',
  bat: 'dos',
  asm: 'x86asm',
};

/**
 * The grammar's name when there is one for `language`, loading it if needed; else `null`. A
 * grammar that fails to load leaves the text plain, which still shows the file.
 */
export async function grammar(language: string): Promise<string | null> {
  const lower = language.toLowerCase();
  const name = Object.hasOwn(ALIASES, lower) ? (ALIASES[lower] ?? lower) : lower;
  if (lowlight.registered(name)) return name;
  const load = Object.hasOwn(EXTRA, name) ? EXTRA[name] : undefined;
  if (load === undefined) return null;
  try {
    lowlight.register(name, (await load()).default);
  } catch (error) {
    console.warn(`the ${name} grammar did not load; the text stays plain`, error);
    return null;
  }
  return name;
}

function toNode(node: Element | Root): Node {
  const holder = node.type === 'root' ? document.createDocumentFragment() : span(node);
  for (const child of node.children) {
    if (child.type === 'text') holder.append(child.value);
    else if (child.type === 'element') holder.append(toNode(child));
  }
  return holder;
}

function span(element: Element): HTMLSpanElement {
  const result = document.createElement('span');
  const classes = element.properties.className;
  if (Array.isArray(classes)) result.className = classes.filter((name) => typeof name === 'string').join(' ');
  return result;
}

/** `text` as highlighted spans in `language` (a grammar name from `grammar`). */
export function highlight(text: string, language: string): Node {
  return toNode(lowlight.highlight(language, text));
}
