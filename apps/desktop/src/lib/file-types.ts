// File types by extension: the icon family and palette colour of each (app-shell handoff 14B,
// design/tokens/README.md "Palette usage"). The preview lane adds how each type renders.

import type { PaletteColor } from './palette';

export type FileType =
  | 'pdf'
  | 'word'
  | 'powerpoint'
  | 'excel'
  | 'markdown'
  | 'code'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'text'
  | 'other';

const EXTENSIONS: Readonly<Record<string, FileType>> = {
  pdf: 'pdf',
  ...all('word', ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf']),
  ...all('powerpoint', ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'key']),
  ...all('excel', ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'ods', 'numbers']),
  ...all('markdown', ['md', 'markdown', 'mdown', 'mkd']),
  ...all('code', [
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'java', 'kt', 'kts', 'scala', 'go', 'rs',
    'py', 'pyw', 'ipynb', 'rb', 'php', 'pl', 'lua', 'r', 'jl', 'm', 'swift', 'dart', 'hs', 'ml',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'html', 'htm', 'css',
    'scss', 'sass', 'less', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sql',
    'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'tex', 'bib', 'sty', 'cls', 'v', 'sv', 'vhd', 'vhdl',
    'asm', 's', 'makefile', 'cmake', 'gradle', 'dockerfile',
  ]),
  ...all('image', [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif', 'tif', 'tiff',
  ]),
  ...all('audio', ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff']),
  ...all('video', ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'ogv']),
  ...all('archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']),
  ...all('text', ['txt', 'text', 'csv', 'tsv', 'log', 'nfo']),
};

function all(type: FileType, extensions: string[]): Record<string, FileType> {
  return Object.fromEntries(extensions.map((extension) => [extension, type]));
}

/**
 * PDF red, Word blue, PowerPoint orange, Excel green, Markdown indigo, code violet, images teal,
 * audio and video pink, archives amber, plain text stone; other files take the secondary text colour.
 */
export const FILE_TYPE_COLOR: Readonly<Record<FileType, PaletteColor | null>> = {
  pdf: 'red',
  word: 'blue',
  powerpoint: 'orange',
  excel: 'green',
  markdown: 'indigo',
  code: 'violet',
  image: 'teal',
  audio: 'pink',
  video: 'pink',
  archive: 'amber',
  text: 'stone',
  other: null,
};

/** The extension after the last dot, lower case; `''` for none. A leading dot is no extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The type of a file by its name. Names without an extension, like `Makefile`, match whole. */
export function fileTypeOf(name: string): FileType {
  const extension = extensionOf(name) || name.toLowerCase();
  return Object.hasOwn(EXTENSIONS, extension) ? (EXTENSIONS[extension] ?? 'other') : 'other';
}
