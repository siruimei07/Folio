// Files for the preview flows (preview.spec.ts), made at test time so the repository holds no
// binary samples: PDFs with text, Chinese text through a predefined CMap, an external link, a
// link to another page and an ICC-profiled image (pdf.js's wasm colour path); PNGs; a WAV tone.
import { deflateSync } from 'node:zlib';

/** A PDF object's body; `stream` adds a stream with its `/Length`. */
interface PdfObject {
  dict: string;
  stream?: Buffer;
}

function pdfFile(objects: PdfObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const head = object.stream
      ? `${String(index + 1)} 0 obj\n${object.dict.replace(/>>\s*$/, ` /Length ${String(object.stream.length)} >>`)}\nstream\n`
      : `${String(index + 1)} 0 obj\n${object.dict}\nendobj\n`;
    const chunk = object.stream
      ? Buffer.concat([Buffer.from(head, 'latin1'), object.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(head, 'latin1');
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`,
  ].join('');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** UTF-16BE hex of `text`, for a font with the UniGB-UCS2-H CMap. */
function ucs2(text: string): string {
  return Array.from(text, (char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')).join('');
}

/** A grey "scan": lines of text-like bars on paper with some grain, different per page. */
function scanImage(width: number, height: number, seed: number): Buffer {
  const rowBytes = width * 3;
  // Paper with grain, made once; each row starts at another offset into it.
  const grain = Buffer.alloc(rowBytes * 2);
  let random = (seed * 2654435761) >>> 0;
  for (let index = 0; index < grain.length; index += 3) {
    random = (Math.imul(random, 1103515245) + 12345) >>> 0;
    grain.fill(0xe8 + (random >>> 28), index, index + 3);
  }
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const offset = ((y * 7919 + seed * 104729) % width) * 3;
    grain.copy(pixels, y * rowBytes, offset, offset + rowBytes);
    const line = Math.floor(y / 18);
    if (y % 18 < 9 && line % 7 !== 6) {
      const end = Math.floor(width * (0.55 + ((line * 37 + seed) % 40) / 100));
      pixels.fill(0x40, y * rowBytes + Math.floor(width * 0.1) * 3, y * rowBytes + end * 3);
    }
  }
  return deflateSync(pixels, { level: 1 });
}

export interface PdfOptions {
  pages: number;
  /** An ICC profile for the page images (`[/ICCBased …]`); none: text pages. */
  iccProfile?: Buffer;
  /** Image size of a scanned page, in pixels. */
  scan?: { width: number; height: number };
}

/**
 * Page 1: a title, Chinese text, an external link and a link to page 2; every page its number.
 * With `iccProfile`, every page also shows a scanned image in that colour space.
 */
export function pdf({ pages, iccProfile, scan = { width: 425, height: 550 } }: PdfOptions): Buffer {
  // 1 catalog, 2 pages, 3 Helvetica, 4 STSong (Type0), 5 its CIDFont, 6 ICC profile, then per page:
  // page, contents, image.
  const first = 7;
  const pageIds = Array.from({ length: pages }, (_, index) => first + index * 3);
  const objects: PdfObject[] = [
    { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { dict: `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pages)} >>` },
    { dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    { dict: '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>' },
    {
      dict: '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >> >>',
    },
    iccProfile ? { dict: '<< /N 3 >>', stream: iccProfile } : { dict: '<< >>' },
  ];
  for (let index = 0; index < pages; index++) {
    const pageId = pageIds[index] ?? 0;
    const number = String(index + 1);
    const text =
      index === 0
        ? `BT /F1 24 Tf 72 720 Td (Week 1 Lecture) Tj ET BT /F2 18 Tf 72 680 Td <${ucs2('线性代数 第一讲')}> Tj ET ` +
          'BT /F1 12 Tf 72 640 Td (https://example.com/syllabus) Tj ET BT /F1 12 Tf 72 610 Td (Go to page 2) Tj ET '
        : '';
    const image = iccProfile ? `q 400 0 0 518 106 80 cm /Im1 Do Q ` : '';
    const content = Buffer.from(`${image}${text}BT /F1 10 Tf 290 40 Td (${number}) Tj ET`, 'latin1');
    const annots =
      index === 0
        ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [70 635 260 655] /Border [0 0 0] /A << /S /URI /URI (https://example.com/syllabus) >> >> << /Type /Annot /Subtype /Link /Rect [70 605 160 625] /Border [0 0 0] /Dest [${String(pageIds[1] ?? pageId)} 0 R /Fit] >>]`
        : '';
    objects.push({
      dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(pageId + 1)} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${iccProfile ? ` /XObject << /Im1 ${String(pageId + 2)} 0 R >>` : ''} >>${annots} >>`,
    });
    objects.push({ dict: '<< >>', stream: content });
    objects.push(
      iccProfile
        ? {
            dict: `<< /Type /XObject /Subtype /Image /Width ${String(scan.width)} /Height ${String(scan.height)} /ColorSpace [/ICCBased 6 0 R] /BitsPerComponent 8 /Filter /FlateDecode >>`,
            stream: scanImage(scan.width, scan.height, index + 1),
          }
        : { dict: '<< >>' },
    );
  }
  return pdfFile(objects);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A `width` × `height` PNG: a diagonal gradient in the given colour. */
export function png(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const shade = (x + y) / (width + height);
      rows[at] = Math.round(red * shade);
      rows[at + 1] = Math.round(green * shade);
      rows[at + 2] = Math.round(blue * shade);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One second of a 440 Hz tone, 8 kHz mono 16-bit PCM. */
export function wav(): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let index = 0; index < rate; index++) {
    samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/** The Windows sRGB profile, for the ICC path; callers fall back when a machine has none. */
export const SRGB_PROFILE = 'C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm';
