import { describe, expect, it } from 'vitest';

import { codeLanguageOf, imageTypeOf, previewKindOf } from './kinds';
import { notePath } from './noteImages';

describe('previewKindOf', () => {
  it('renders media in the window and parsed content in the frame', () => {
    expect(previewKindOf('board.PNG')).toEqual({ kind: 'image' });
    expect(previewKindOf('diagram.svg')).toEqual({ kind: 'image' });
    expect(previewKindOf('IMG_0042.HEIC')).toEqual({ kind: 'thumbnail' });
    expect(previewKindOf('scan.tiff')).toEqual({ kind: 'thumbnail' });
    expect(previewKindOf('old.jxl')).toEqual({ kind: 'other' });
    expect(previewKindOf('lecture.m4a')).toEqual({ kind: 'audio' });
    expect(previewKindOf('memo.wma')).toEqual({ kind: 'other' });
    expect(previewKindOf('demo.mp4')).toEqual({ kind: 'video' });
    expect(previewKindOf('old.avi')).toEqual({ kind: 'other' });
    expect(previewKindOf('notes.md')).toEqual({ kind: 'frame', renderer: 'markdown', language: null });
    expect(previewKindOf('ps2.pdf')).toEqual({ kind: 'frame', renderer: 'pdf', language: null });
    expect(previewKindOf('data.csv')).toEqual({ kind: 'frame', renderer: 'text', language: null });
    expect(previewKindOf('hw1.py')).toEqual({ kind: 'frame', renderer: 'code', language: 'python' });
    expect(previewKindOf('Makefile')).toEqual({ kind: 'frame', renderer: 'code', language: 'makefile' });
  });

  it('gives Office files and everything else the card', () => {
    for (const name of ['essay.docx', 'Week 1.pptx', 'grades.xlsx', 'old.doc']) {
      expect(previewKindOf(name)).toEqual({ kind: 'office' });
    }
    for (const name of ['setup.exe', 'backup.zip', 'README']) expect(previewKindOf(name)).toEqual({ kind: 'other' });
  });
});

describe('codeLanguageOf and imageTypeOf', () => {
  it('map extensions, never content', () => {
    expect(codeLanguageOf('solver.m')).toBe('matlab');
    expect(codeLanguageOf('adder.sv')).toBe('verilog');
    expect(codeLanguageOf('report.tex')).toBe('latex');
    expect(codeLanguageOf('Dockerfile')).toBe('dockerfile');
    expect(codeLanguageOf('notes.unknown')).toBeNull();
    expect(imageTypeOf('a.SVG')).toBe('image/svg+xml');
    expect(imageTypeOf('a.jpeg')).toBe('image/jpeg');
    expect(imageTypeOf('a.heic')).toBeNull();
    expect(imageTypeOf('a.pdf')).toBeNull();
  });
});

describe('notePath', () => {
  it('decodes relative paths a note writes', () => {
    expect(notePath('figure.png')).toBe('figure.png');
    expect(notePath('images/My%20figure.png?raw=1#top')).toBe('images/My figure.png');
    expect(notePath('..\\shared\\图1.png')).toBe('..\\shared\\图1.png');
    expect(notePath('%E5%9B%BE.png')).toBe('图.png');
  });

  it('refuses absolute paths, schemes and broken escapes', () => {
    for (const raw of ['/etc/passwd', '\\\\server\\share\\a.png', 'C:/Users/a.png', 'c:a.png', 'file:///C:/a.png', 'https://x/a.png', '%E5.png', '', '?x']) {
      expect(notePath(raw), raw).toBeNull();
    }
  });
});
