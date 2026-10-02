// Text as the frame shows it (UI architecture §10.1): UTF-8, UTF-16 when a byte order mark says
// so, and GB18030 for text that is not valid UTF-8, since many Chinese notes written on Windows
// are GBK (which GB18030 contains).

/** Bytes looked at for NUL characters, which no text file has. */
const SNIFF_BYTES = 8192;

function decodeAny(bytes: Uint8Array): string | null {
  // A BOM decides; TextDecoder drops it from the text.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

/**
 * The file's text with Windows and old Mac line breaks as `\n`, or `null` for binary content
 * behind a text extension.
 */
export function decodeText(buffer: ArrayBuffer): string | null {
  return decodeAny(new Uint8Array(buffer))?.replace(/\r\n?/g, '\n') ?? null;
}

/** The number of lines in `text`: a final line break ends the last line, it does not start one. */
export function lineCount(text: string): number {
  if (text === '') return 1;
  let count = 1;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
  return text.endsWith('\n') ? count - 1 : count;
}
