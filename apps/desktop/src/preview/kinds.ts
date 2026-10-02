// How each file type previews (UI architecture §10.1): media in the window by URL, everything
// parsed from file content in the sandboxed frame, and a card for the rest. By extension only
// (`lib/file-types.ts`); the content never decides, so a file cannot pick its own renderer.

import { extensionOf, fileTypeOf } from '../lib/file-types';
import type { Renderer } from './protocol';

type PreviewKind =
  | { kind: 'image' }
  | { kind: 'thumbnail' }
  | { kind: 'audio' }
  | { kind: 'video' }
  | { kind: 'frame'; renderer: Renderer; language: string | null }
  | { kind: 'office' }
  | { kind: 'other' };

/** Image types Chromium decodes, with the MIME type the frame's `blob:` URLs need (SVG included). */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** Audio and video Chromium plays; the others get the card ("Open with default app"). */
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);

/** Images Chromium cannot decode but Windows can thumbnail (WIC), with its HEIF extension for HEIC. */
const THUMBNAILED = new Set(['heic', 'heif', 'tif', 'tiff']);

/** highlight.js languages by extension; extensions it does not know show as plain text. */
const LANGUAGES: Readonly<Record<string, string>> = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  go: 'go',
  rs: 'rust',
  py: 'python',
  pyw: 'python',
  ipynb: 'json',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  m: 'matlab',
  swift: 'swift',
  dart: 'dart',
  hs: 'haskell',
  ml: 'ocaml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  svelte: 'xml',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  bib: 'latex',
  v: 'verilog',
  sv: 'verilog',
  vhd: 'vhdl',
  vhdl: 'vhdl',
  asm: 'x86asm',
  s: 'x86asm',
  makefile: 'makefile',
  cmake: 'cmake',
  gradle: 'gradle',
  dockerfile: 'dockerfile',
};

/** The highlight.js language of a code file, or `null` to show it as plain text. */
export function codeLanguageOf(name: string): string | null {
  const extension = extensionOf(name) || name.toLowerCase();
  return Object.hasOwn(LANGUAGES, extension) ? (LANGUAGES[extension] ?? null) : null;
}

/** How a file previews, by its name. */
export function previewKindOf(name: string): PreviewKind {
  const extension = extensionOf(name);
  switch (fileTypeOf(name)) {
    case 'image':
      if (imageTypeOf(name) !== null) return { kind: 'image' };
      return THUMBNAILED.has(extension) ? { kind: 'thumbnail' } : { kind: 'other' };
    case 'audio':
      return AUDIO.has(extension) ? { kind: 'audio' } : { kind: 'other' };
    case 'video':
      return VIDEO.has(extension) ? { kind: 'video' } : { kind: 'other' };
    case 'text':
      return { kind: 'frame', renderer: 'text', language: null };
    case 'code':
      return { kind: 'frame', renderer: 'code', language: codeLanguageOf(name) };
    case 'markdown':
      return { kind: 'frame', renderer: 'markdown', language: null };
    case 'pdf':
      return { kind: 'frame', renderer: 'pdf', language: null };
    case 'word':
    case 'excel':
    case 'powerpoint':
      return { kind: 'office' };
    case 'archive':
    case 'other':
      return { kind: 'other' };
  }
}

/** The MIME type of an image the frame can show, or `null` for any other file. */
export function imageTypeOf(name: string): string | null {
  const extension = extensionOf(name);
  return Object.hasOwn(IMAGE_TYPES, extension) ? (IMAGE_TYPES[extension] ?? null) : null;
}
