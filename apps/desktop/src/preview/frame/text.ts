// Text and code (UI architecture §10.1, §10.4): decoded text with line numbers, highlighted by its
// extension's grammar up to 1 MB and 20,000 lines, plain above. Highlighting loads only for code
// it will colour, so a plain text file never loads the grammars.

import { HIGHLIGHT_LIMITS } from '../protocol';
import { decodeText, lineCount } from './decode';
import { showLines } from './lines';
import { RenderFailure, type RenderFile } from './view';

export const renderText: RenderFile = async (root, { bytes, renderer, language, strings }) => {
  const text = decodeText(bytes);
  if (text === null) throw new RenderFailure('unsupported');
  const lines = lineCount(text);
  let content: Node = document.createTextNode(text);
  if (
    renderer === 'code' &&
    language !== null &&
    bytes.byteLength <= HIGHLIGHT_LIMITS.bytes &&
    lines <= HIGHLIGHT_LIMITS.lines
  ) {
    const { grammar, highlight } = await import('./highlight');
    const name = await grammar(language);
    if (name !== null) content = highlight(text, name);
  }
  showLines(root, content, lines, strings.code);
  return {};
};
