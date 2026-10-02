// The text and code view (app-shell handoff §5): line numbers in a gutter that stays put while the
// lines scroll sideways, then the lines themselves. The numbers are one text node and the lines
// one `<pre>`, so a 5 MB log costs a handful of elements, and selecting text never takes numbers.

/** "1\n2\n…\nlines", built without an array of a string per line. */
function numbers(lines: number): string {
  let text = '1';
  for (let line = 2; line <= lines; line++) text += `\n${String(line)}`;
  return text;
}

/** Builds the view into `root`; `content` is the text, or the highlighted spans of the code. */
export function showLines(root: HTMLElement, content: Node, lines: number, label: string): void {
  const view = document.createElement('div');
  view.className = 'lines';

  const gutter = document.createElement('pre');
  gutter.className = 'lines__gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = numbers(lines);

  const text = document.createElement('pre');
  text.className = 'lines__text';
  text.setAttribute('aria-label', label);
  const code = document.createElement('code');
  code.append(content);
  text.append(code);

  view.append(gutter, text);
  root.replaceChildren(view);
}
