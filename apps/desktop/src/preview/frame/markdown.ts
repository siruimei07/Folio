// Markdown notes (UI architecture §10.4): markdown-it with tables, strikethrough and links found in
// the text; maths through @mdit/plugin-tex and Temml, which writes MathML that Chromium renders
// with Cambria Math; DOMPurify over the whole output; highlighted code blocks; images next to the
// note through the window; links that show their address and never navigate. Temml and the
// grammars load only for notes that have maths or fenced code.

import 'temml/dist/Temml-Local.css';
import './markdown.css';

import { tex } from '@mdit/plugin-tex';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

import { HIGHLIGHT_LIMITS } from '../protocol';
import { decodeText } from './decode';
import { prepareImages } from './noteImages';
import { RenderFailure, type RenderFile } from './view';

/** What a note's raw HTML may not use, beyond what DOMPurify's HTML and MathML profiles drop. */
const FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'datalist',
  'link',
  'meta',
  'base',
  'audio',
  'video',
  'source',
  'track',
  'picture',
  'canvas',
  'dialog',
  'template',
];
const FORBID_ATTR = ['srcset', 'target', 'ping', 'formaction', 'action'];

/** Relative paths, `http`, `https`, `mailto` and `#` fragments; `data:` images pass DOMPurify's own check. */
const ALLOWED_URI = /^(?:(?:https?|mailto):|#|(?![a-z][a-z0-9+.-]*:))/i;

/** Temml's limits: a hostile formula cannot make huge boxes or expand macros without end. */
const MATH_LIMITS = { maxSize: [50, 50] as [number, number], maxExpand: 1000 };

/** Anything the maths plugin could take for a formula: `$`, `\(`, `\[` or a ```` ```math ```` fence. */
const MATHS = /\$|\\[([]|```math/;

type Temml = (typeof import('temml'))['default'];

function markdownIt(temml: Temml | null) {
  const md = new MarkdownIt({ html: true, linkify: true });
  if (temml !== null) {
    md.use(tex, {
      delimiters: 'all',
      mathFence: true,
      render: (content, displayMode) =>
        temml.renderToString(content, { displayMode, trust: false, throwOnError: false, ...MATH_LIMITS }),
    });
  }
  return md;
}

function sanitize(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
}

/**
 * Highlights fenced code by the fence's language, each block up to the code renderer's limit;
 * unknown languages and longer blocks stay plain.
 */
async function highlightBlocks(root: ParentNode): Promise<void> {
  const blocks = Array.from(root.querySelectorAll('pre > code'), (code) => ({
    code,
    language: Array.from(code.classList)
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length),
  })).filter(
    (block): block is { code: Element; language: string } =>
      block.language !== undefined && block.language !== '' && block.code.textContent.length <= HIGHLIGHT_LIMITS.bytes,
  );
  if (blocks.length === 0) return;
  const { grammar, highlight } = await import('./highlight');
  const languages = [...new Set(blocks.map((block) => block.language))];
  const names = new Map(await Promise.all(languages.map(async (language) => [language, await grammar(language)] as const)));
  for (const { code, language } of blocks) {
    const name = names.get(language);
    if (name != null) code.replaceChildren(highlight(code.textContent, name));
  }
}

/** Every link shows its address as a tooltip (ADR-0005, product decision 2). */
function titleLinks(root: ParentNode): void {
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    if (!link.hasAttribute('title')) link.setAttribute('title', href);
  }
}

export const renderMarkdown: RenderFile = async (root, { bytes, strings }) => {
  const text = decodeText(bytes);
  if (text === null) throw new RenderFailure('unsupported');
  const temml = MATHS.test(text) ? (await import('temml')).default : null;
  const note = sanitize(markdownIt(temml).render(text));
  titleLinks(note);
  await highlightBlocks(note);
  const article = document.createElement('article');
  article.className = 'note';
  article.append(note);
  root.replaceChildren(article);
  return { image: prepareImages(article, strings) };
};
