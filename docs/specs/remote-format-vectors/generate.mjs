// Golden vectors for docs/specs/remote-format.md (history format, version 1).
//
// Run from the repository root with Node 24:
//   node docs/specs/remote-format-vectors/generate.mjs           writes v1/*.json
//   node docs/specs/remote-format-vectors/generate.mjs --check   fails if v1/ differs (pnpm check)
//
// A second implementation of the format, written from the spec and independent of folio-core:
// BLAKE3 follows the reference implementation in the BLAKE3 paper; canonical JSON, names,
// objects, change records, packs and records follow remote-format.md. Its readers return an
// outcome for any input and never throw on bad data. The zstd frames a compressor made are data
// (FRAMES): made once with the libzstd that Node bundles and checked here by decoding them, so
// the output never depends on a compressor's version. Published vectors never change; a new
// version of a part of the format adds a folder (v2/) instead.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync, constants as zlib } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'v1');

// ---------------------------------------------------------------------------------------------
// Bytes

const utf8 = (text) => new TextEncoder().encode(text);
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const equalBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const compareBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const compareUtf8 = (a, b) => compareBytes(utf8(a), utf8(b));
const pattern = (length) => Uint8Array.from({ length }, (_, i) => i % 251);
const isStrictlyAscending = (list, compare) => list.every((item, i) => i === 0 || compare(list[i - 1], item) < 0);

/** JavaScript strings are UTF-16, so their length is the count the name and path limits use. */
const utf16Length = (text) => text.length;

function u32le(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64le(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

/** A little-endian unsigned integer; null past the end of `bytes` or above 2^53 - 1. */
function readUint(bytes, offset, size) {
  if (offset < 0 || offset + size > bytes.length) return null;
  let value = 0n;
  for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

// ---------------------------------------------------------------------------------------------
// BLAKE3: hash mode and derive_key mode, 32-byte output

const IV = Uint32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
);
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const DERIVE_KEY_CONTEXT = 32;
const DERIVE_KEY_MATERIAL = 64;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(s, a, b, c, d, x, y) {
  s[a] = s[a] + s[b] + x;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = s[c] + s[d];
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = s[a] + s[b] + y;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = s[c] + s[d];
  s[b] = rotr(s[b] ^ s[c], 7);
}

function compress(cv, blockWords, counter, blockLen, flags) {
  const s = new Uint32Array(16);
  s.set(cv, 0);
  s.set(IV.subarray(0, 4), 8);
  s[12] = counter % 2 ** 32;
  s[13] = Math.floor(counter / 2 ** 32);
  s[14] = blockLen;
  s[15] = flags;
  let m = Uint32Array.from(blockWords);
  for (let round = 0; round < 7; round++) {
    g(s, 0, 4, 8, 12, m[0], m[1]);
    g(s, 1, 5, 9, 13, m[2], m[3]);
    g(s, 2, 6, 10, 14, m[4], m[5]);
    g(s, 3, 7, 11, 15, m[6], m[7]);
    g(s, 0, 5, 10, 15, m[8], m[9]);
    g(s, 1, 6, 11, 12, m[10], m[11]);
    g(s, 2, 7, 8, 13, m[12], m[13]);
    g(s, 3, 4, 9, 14, m[14], m[15]);
    if (round < 6) {
      const permuted = m;
      m = Uint32Array.from(MSG_PERMUTATION, (i) => permuted[i]);
    }
  }
  for (let i = 0; i < 8; i++) {
    s[i] ^= s[i + 8];
    s[i + 8] ^= cv[i];
  }
  return s;
}

function words(bytes) {
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24);
  }
  return out;
}

class Output {
  constructor(cv, blockWords, counter, blockLen, flags) {
    Object.assign(this, { cv, blockWords, counter, blockLen, flags });
  }

  chainingValue() {
    return compress(this.cv, this.blockWords, this.counter, this.blockLen, this.flags).slice(0, 8);
  }

  rootBytes(length) {
    const out = new Uint8Array(length);
    for (let i = 0, counter = 0; i < length; counter++) {
      const block = compress(this.cv, this.blockWords, counter, this.blockLen, this.flags | ROOT);
      for (const word of block) {
        for (let k = 0; k < 4 && i < length; k++) out[i++] = (word >>> (8 * k)) & 0xff;
      }
    }
    return out;
  }
}

class ChunkState {
  constructor(key, chunkCounter, flags) {
    this.cv = Uint32Array.from(key);
    this.chunkCounter = chunkCounter;
    this.flags = flags;
    this.block = new Uint8Array(BLOCK_LEN);
    this.blockLen = 0;
    this.blocksCompressed = 0;
  }

  get length() {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }

  get startFlag() {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }

  update(input) {
    for (let pos = 0; pos < input.length; ) {
      if (this.blockLen === BLOCK_LEN) {
        const flags = this.flags | this.startFlag;
        this.cv = compress(this.cv, words(this.block), this.chunkCounter, BLOCK_LEN, flags).slice(0, 8);
        this.blocksCompressed++;
        this.block = new Uint8Array(BLOCK_LEN);
        this.blockLen = 0;
      }
      const take = Math.min(BLOCK_LEN - this.blockLen, input.length - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }

  output() {
    const flags = this.flags | this.startFlag | CHUNK_END;
    return new Output(this.cv, words(this.block), this.chunkCounter, this.blockLen, flags);
  }
}

function parentOutput(left, right, key, flags) {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return new Output(key, block, 0, BLOCK_LEN, flags | PARENT);
}

class Hasher {
  constructor(key = IV, flags = 0) {
    this.key = Uint32Array.from(key);
    this.flags = flags;
    this.chunk = new ChunkState(this.key, 0, flags);
    this.stack = [];
  }

  update(input) {
    for (let pos = 0; pos < input.length; ) {
      if (this.chunk.length === CHUNK_LEN) {
        let cv = this.chunk.output().chainingValue();
        let total = this.chunk.chunkCounter + 1;
        this.chunk = new ChunkState(this.key, total, this.flags);
        while (total % 2 === 0) {
          cv = parentOutput(this.stack.pop(), cv, this.key, this.flags).chainingValue();
          total /= 2;
        }
        this.stack.push(cv);
      }
      const take = Math.min(CHUNK_LEN - this.chunk.length, input.length - pos);
      this.chunk.update(input.subarray(pos, pos + take));
      pos += take;
    }
    return this;
  }

  finalize() {
    let output = this.chunk.output();
    for (let i = this.stack.length - 1; i >= 0; i--) {
      output = parentOutput(this.stack[i], output.chainingValue(), this.key, this.flags);
    }
    return output.rootBytes(32);
  }
}

const blake3 = (bytes) => new Hasher().update(bytes).finalize();

function deriveKey(context, material) {
  const contextKey = new Hasher(IV, DERIVE_KEY_CONTEXT).update(utf8(context)).finalize();
  return new Hasher(words(contextKey), DERIVE_KEY_MATERIAL).update(material).finalize();
}

const TREE_CONTEXT = 'folio tree v1';
const COMMIT_CONTEXT = 'folio commit v1';
const textId = (bytes) => `b3:${hex(bytes)}`;
const blobId = (bytes) => textId(blake3(bytes));
const treeId = (canonicalBytes) => textId(deriveKey(TREE_CONTEXT, canonicalBytes));
const commitId = (canonicalBytes) => textId(deriveKey(COMMIT_CONTEXT, canonicalBytes));

// ---------------------------------------------------------------------------------------------
// Canonical JSON (remote-format.md §5)

/** The deepest an object or array may lie: the document's own object is level 1. */
const MAX_DEPTH = 16;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function quote(text) {
  if (!text.isWellFormed()) throw new Error('a string holds a lone surrogate');
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function canonicalText(value, depth = 1) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new Error(`not an allowed integer: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return quote(value);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new Error(`not a value of the format: ${Object.prototype.toString.call(value)}`);
  }
  if (depth > MAX_DEPTH) throw new Error('nested too deeply');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalText(item, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys.map((key) => `${quote(key)}:${canonicalText(value[key], depth + 1)}`).join(',')}}`;
}

const canonical = (value) => utf8(canonicalText(value));

class Reject extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

class Num {
  constructor(raw) {
    this.raw = raw;
  }
}

/** RFC 8259 JSON, numbers kept as their text, duplicate keys and deep nesting refused. */
function parseJson(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Reject('utf8');
  }
  let i = 0;
  let depth = 0;
  const fail = (reason = 'json') => {
    throw new Reject(reason);
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  function string() {
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail();
      const ch = text[i];
      if (ch === '"') {
        i++;
        break;
      }
      if (ch === '\\') {
        const escape = text[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (Object.hasOwn(simple, escape)) {
          out += simple[escape];
          i += 2;
          continue;
        }
        const digits = text.slice(i + 2, i + 6);
        if (escape !== 'u' || !/^[0-9a-fA-F]{4}$/.test(digits)) fail();
        out += String.fromCharCode(parseInt(digits, 16));
        i += 6;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) fail();
      out += ch;
      i++;
    }
    if (!out.isWellFormed()) fail('lone-surrogate');
    return out;
  }
  function members(close, member) {
    if (++depth > MAX_DEPTH) fail('depth');
    i++;
    space();
    if (text[i] === close) {
      i++;
    } else {
      for (;;) {
        member();
        space();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== close) fail();
        i++;
        break;
      }
    }
    depth--;
  }
  function value() {
    space();
    const ch = text[i];
    if (ch === '{') {
      const out = Object.create(null);
      members('}', () => {
        space();
        if (text[i] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key)) fail('duplicate-key');
        space();
        if (text[i] !== ':') fail();
        i++;
        out[key] = value();
      });
      return out;
    }
    if (ch === '[') {
      const out = [];
      members(']', () => out.push(value()));
      return out;
    }
    if (ch === '"') return string();
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!number) fail();
    i += number[0].length;
    return new Num(number[0]);
  }
  const result = value();
  space();
  if (i !== text.length) fail();
  return result;
}

function plain(value) {
  if (value === null) throw new Reject('null');
  if (value instanceof Num) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value.raw)) throw new Reject('number');
    const number = Number(value.raw);
    if (!Number.isSafeInteger(number)) throw new Reject('number');
    return number;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

/** The value of a canonical JSON document, or a Reject with the reason. */
function parseCanonical(bytes) {
  const value = plain(parseJson(bytes));
  if (!equalBytes(canonical(value), bytes)) throw new Reject('noncanonical');
  return value;
}

// ---------------------------------------------------------------------------------------------
// Values (remote-format.md §6)

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function keysAre(value, keys) {
  if (!isObject(value)) return false;
  const own = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return own.length === wanted.length && own.every((key, i) => key === wanted[i]);
}

/** Every required key is there and no other than the optional ones. */
const keysWithin = (value, { required, optional }) =>
  isObject(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const isObjectId = (text) => typeof text === 'string' && /^b3:[0-9a-f]{64}$/.test(text);
const isId128 = (text) => typeof text === 'string' && /^[0-9a-f]{32}$/.test(text);
const isSize = (value) => Number.isSafeInteger(value) && value >= 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 1;

const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const isWhiteSpace = (ch) => WHITE_SPACE.has(ch.codePointAt(0));
const isControl = (ch) => {
  const code = ch.codePointAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

function lineText(text, max) {
  if (typeof text !== 'string' || !text.isWellFormed()) return false;
  const chars = [...text];
  return (
    chars.length >= 1 &&
    chars.length <= max &&
    !isWhiteSpace(chars[0]) &&
    !isWhiteSpace(chars.at(-1)) &&
    !chars.some(isControl)
  );
}

const isDisplayName = (text) => lineText(text, 128);
const isSummary = (text) => lineText(text, 256);

function isBody(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) return false;
  const chars = [...text];
  return (
    chars.length >= 1 &&
    chars.length <= 16384 &&
    chars[0] !== '\n' &&
    !isWhiteSpace(chars.at(-1)) &&
    !chars.some((ch) => isControl(ch) && ch !== '\t' && ch !== '\n')
  );
}

function isTime(text) {
  const m = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= days &&
    hour <= 23 && minute <= 59 && second <= 59
  );
}

const asciiUpper = (text) => text.replace(/[a-z]/g, (ch) => ch.toUpperCase());

/** Windows device names, as `paths::is_device_name` defines them. */
function isDeviceName(name) {
  const dot = name.indexOf('.');
  const stem = (dot === -1 ? name : name.slice(0, dot)).replace(/ +$/, '');
  if (['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'].includes(asciiUpper(stem))) return true;
  const chars = [...stem];
  return (
    chars.length === 4 &&
    ['COM', 'LPT'].includes(asciiUpper(chars.slice(0, 3).join(''))) &&
    /^[0-9¹²³]$/u.test(chars[3])
  );
}

const isNfc = (text) => text.normalize('NFC') === text;

/** The rule of §6.4 a name breaks first, or null. */
function nameProblem(name) {
  if (typeof name !== 'string' || !name.isWellFormed()) return 'notUnicode';
  if (name === '') return 'empty';
  if (name === '.' || name === '..') return 'dotName';
  for (const ch of name) {
    if (ch.codePointAt(0) < 0x20 || '<>:"/\\|?*'.includes(ch)) return 'invalidCharacter';
  }
  if (name.endsWith('.') || name.endsWith(' ')) return 'trailingDotOrSpace';
  if (isDeviceName(name)) return 'reservedName';
  if (utf16Length(name) > 255) return 'tooLong';
  if (!isNfc(name)) return 'notNfc';
  return null;
}

function pathProblem(path) {
  if (typeof path !== 'string') return 'notUnicode';
  for (const name of path.split('/')) {
    const problem = nameProblem(name);
    if (problem) return problem;
  }
  return utf16Length(path) > 32767 ? 'pathTooLong' : null;
}

/** Whether `name` names `target` as NTFS compares names (§7.4): ASCII case ignored, ı as i, ſ as s. */
const sameName = (name, target) =>
  name.replace(/[A-Z]/g, (ch) => ch.toLowerCase()).replace(/ı/g, 'i').replace(/ſ/g, 's') === target;

// ---------------------------------------------------------------------------------------------
// Objects (remote-format.md §7, §8)

const OP_RANK = { delete: 0, add: 1, modify: 2, move: 3 };
const compareChanges = (a, b) => compareUtf8(a.path, b.path) || OP_RANK[a.op] - OP_RANK[b.op];
const sideOf = (entry) => ({ hash: entry.hash, size: entry.size, stored: entry.stored });
const sameSide = (a, b) => a.hash === b.hash && a.size === b.size && a.stored === b.stored;
const sameEntry = (a, b) => a.kind === b.kind && (a.kind === 'dir' || sameSide(a, b));

function treeProblem(tree) {
  if (!keysAre(tree, ['entries']) || !Array.isArray(tree.entries)) return 'schema';
  for (const entry of tree.entries) {
    const keys = entry?.kind === 'file' ? ['hash', 'kind', 'name', 'size', 'stored'] : ['hash', 'kind', 'name'];
    if (!['file', 'dir'].includes(entry?.kind) || !keysAre(entry, keys) || !isObjectId(entry.hash)) return 'schema';
    if (entry.kind === 'file' && (!isSize(entry.size) || typeof entry.stored !== 'boolean')) return 'schema';
    const problem = nameProblem(entry.name);
    if (problem) return `name:${problem}`;
  }
  return isStrictlyAscending(tree.entries, (a, b) => compareUtf8(a.name, b.name)) ? null : 'order';
}

const CHANGE_KEYS = new Map([
  ['add file', ['kind', 'new', 'op', 'path']],
  ['add dir', ['kind', 'op', 'path']],
  ['delete file', ['kind', 'old', 'op', 'path']],
  ['delete dir', ['kind', 'op', 'path']],
  ['modify file', ['kind', 'new', 'old', 'op', 'path']],
  ['move file', ['from', 'kind', 'new', 'old', 'op', 'path']],
  ['move dir', ['from', 'kind', 'op', 'path']],
]);
const isSide = (side) =>
  keysAre(side, ['hash', 'size', 'stored']) &&
  isObjectId(side.hash) &&
  isSize(side.size) &&
  typeof side.stored === 'boolean';

function changeProblem(change) {
  const known = isObject(change) && typeof change.op === 'string' && typeof change.kind === 'string';
  const keys = known ? CHANGE_KEYS.get(`${change.op} ${change.kind}`) : undefined;
  if (!keys || !keysAre(change, keys)) return 'schema';
  if (pathProblem(change.path)) return 'path';
  if (Object.hasOwn(change, 'from') && (pathProblem(change.from) || change.from === change.path)) return 'path';
  for (const side of ['old', 'new']) {
    if (Object.hasOwn(change, side) && !isSide(change[side])) return 'schema';
  }
  if (change.op === 'modify' && sameSide(change.old, change.new)) return 'schema';
  return null;
}

const MESSAGE_KEYS = {
  required: ['device', 'kind', 'summary', 'time', 'tree'],
  optional: ['body', 'changes', 'parent', 'rebased_from'],
};
const COMMIT_KINDS = new Map([
  ['commit', MESSAGE_KEYS],
  ['import', MESSAGE_KEYS],
  ['prune', { required: ['device', 'kind', 'parent', 'pruned', 'time', 'tree'], optional: ['rebased_from'] }],
]);

const isDevice = (device) =>
  keysAre(device, ['id', 'name']) && isId128(device.id) && isDisplayName(device.name);

function commitProblem(commit) {
  const spec = isObject(commit) && typeof commit.kind === 'string' ? COMMIT_KINDS.get(commit.kind) : undefined;
  if (!spec || !keysWithin(commit, spec)) return 'schema';
  if (!isDevice(commit.device) || !isTime(commit.time) || !isObjectId(commit.tree)) return 'schema';
  for (const key of ['parent', 'rebased_from']) {
    if (Object.hasOwn(commit, key) && !isObjectId(commit[key])) return 'schema';
  }
  if (commit.kind === 'prune') {
    const pruned = commit.pruned;
    if (!Array.isArray(pruned) || pruned.length < 1 || pruned.length > 100000) return 'schema';
    if (!pruned.every(isObjectId)) return 'schema';
    return isStrictlyAscending(pruned, compareUtf8) ? null : 'order';
  }
  if (!isSummary(commit.summary)) return 'summary';
  if (Object.hasOwn(commit, 'body') && !isBody(commit.body)) return 'body';
  if (Object.hasOwn(commit, 'changes')) {
    const changes = commit.changes;
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100000) return 'schema';
    for (const change of changes) {
      const problem = changeProblem(change);
      if (problem) return `change:${problem}`;
    }
    if (!isStrictlyAscending(changes, compareChanges)) return 'order';
  }
  return null;
}

class Missing {
  constructor(id) {
    this.id = id;
  }
}

/**
 * Every path of a tree with its entry, a folder as { kind: "dir" } and a file as
 * { kind: "file", hash, size, stored }; a Missing when a tree it needs is absent.
 */
function flatten(id, trees, prefix = '', out = new Map()) {
  const tree = trees.get(id);
  if (!tree) return new Missing(id);
  for (const entry of tree.entries) {
    const path = prefix + entry.name;
    if (entry.kind === 'dir') {
      out.set(path, { kind: 'dir' });
      const inner = flatten(entry.hash, trees, `${path}/`, out);
      if (inner instanceof Missing) return inner;
    } else {
      out.set(path, { kind: 'file', ...sideOf(entry) });
    }
  }
  return out;
}

/** §7.4: what a commit's root tree must hold, and what it may not. */
function rootProblem(tree) {
  for (const path of tree.keys()) {
    if (!path.includes('/') && sameName(path, '.folio') && path !== '.folio') return 'folio-name';
    if (utf16Length(path) > 32767) return 'path-too-long';
  }
  if (tree.get('.folio')?.kind !== 'dir' || tree.get('.folio/library.json')?.kind !== 'file') {
    return 'folio-missing';
  }
  for (const [path, entry] of tree) {
    if (!path.startsWith('.folio/')) continue;
    const names = path.split('/').slice(1);
    if (names.length === 1 && (sameName(names[0], 'local') || sameName(names[0], 'store'))) return 'folio-private';
    // Files anywhere the layout allows; the only folders are `meta` and the folders in it.
    const folderAllowed = (names.length === 1 && names[0] === 'meta') || (names.length === 2 && names[0] === 'meta');
    if (entry.kind === 'dir' ? !folderAllowed : names.length > 3) return 'folio-path';
    if (entry.kind === 'file' && !entry.stored) return 'folio-not-stored';
  }
  return null;
}

/** §8: change records against the parent's tree and the commit's tree. */
function changesProblem(changes, parent, tree) {
  if (changes === undefined) return null;
  const from = new Set([...parent].filter(([p, e]) => !tree.has(p) || !sameEntry(e, tree.get(p))).map(([p]) => p));
  const to = new Set([...tree].filter(([p, e]) => !parent.has(p) || !sameEntry(parent.get(p), e)).map(([p]) => p));
  const seenFrom = new Set();
  const seenTo = new Set();
  const cover = (seen, all, path) => {
    if (!all.has(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  };
  for (const change of changes) {
    if (change.op !== 'add') {
      const fromPath = change.op === 'move' ? change.from : change.path;
      if (!cover(seenFrom, from, fromPath) || parent.get(fromPath).kind !== change.kind) return 'coverage';
      if (change.kind === 'file' && !sameSide(parent.get(fromPath), change.old)) return 'side';
    }
    if (change.op !== 'delete') {
      if (!cover(seenTo, to, change.path) || tree.get(change.path).kind !== change.kind) return 'coverage';
      if (change.kind === 'file' && !sameSide(tree.get(change.path), change.new)) return 'side';
    }
    if (change.op === 'move' && change.kind === 'dir') {
      // What moved along unchanged is covered by the folder's record.
      for (const [path, entry] of parent) {
        if (!path.startsWith(`${change.from}/`)) continue;
        const moved = `${change.path}/${path.slice(change.from.length + 1)}`;
        if (!from.has(path) || !to.has(moved) || !sameEntry(entry, tree.get(moved))) continue;
        if (!cover(seenFrom, from, path) || !cover(seenTo, to, moved)) return 'coverage';
      }
    }
  }
  return seenFrom.size === from.size && seenTo.size === to.size ? null : 'coverage';
}

/** The checks that need the commit's tree and its parent's (§7.3–§7.5, §8): a reason, 'missing' or null. */
function commitContextProblem(commit, parentCommit, trees) {
  const tree = flatten(commit.tree, trees);
  const parentTree = parentCommit ? flatten(parentCommit.tree, trees) : new Map();
  if (tree instanceof Missing || parentTree instanceof Missing) return 'missing';
  const root = rootProblem(tree);
  if (root) return root;
  if (commit.kind === 'prune') {
    if (commit.tree !== parentCommit.tree) return 'prune-tree';
    const stored = new Set([...tree.values()].filter((e) => e.kind === 'file' && e.stored).map((e) => e.hash));
    return commit.pruned.some((id) => stored.has(id)) ? 'prune-current' : null;
  }
  if (parentCommit && commit.tree === parentCommit.tree) return 'empty-commit';
  return changesProblem(commit.changes, parentTree, tree);
}

/** §7.5: an entry of chain[index] whose blob is absent, with the history up to chain's end. */
function absentBlob(chain, index, blob) {
  const prunedLater = chain.slice(index + 1).some(({ commit }) => commit.kind === 'prune' && commit.pruned.includes(blob));
  return prunedLater ? 'pruned' : 'missing';
}

/** §7.5: whether a store may delete `blob` when chain's last commit is the head. */
function deletable(chain, blob) {
  let lastStored = -1;
  let lastPrune = -1;
  chain.forEach(({ commit, flat }, i) => {
    if ([...flat.values()].some((e) => e.kind === 'file' && e.stored && e.hash === blob)) lastStored = i;
    if (commit.kind === 'prune' && commit.pruned.includes(blob)) lastPrune = i;
  });
  return lastPrune > lastStored;
}

// ---------------------------------------------------------------------------------------------
// zstd frames (remote-format.md §9.3)

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_WINDOW = 8 * 1024 * 1024;

/** The header facts of the zstd frame at the start of `bytes` and its length; null if malformed. */
function zstdFrame(bytes) {
  if (bytes.length < 5 || !ZSTD_MAGIC.every((b, i) => bytes[i] === b)) return null;
  const descriptor = bytes[4];
  if ((descriptor >> 3) & 1) return null;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  let pos = 5;
  let window = null;
  if (!singleSegment) {
    if (pos >= bytes.length) return null;
    const wd = bytes[pos++];
    const base = 2 ** (10 + (wd >> 3));
    window = base + (base / 8) * (wd & 7);
  }
  const dictionarySize = [0, 1, 2, 4][descriptor & 3];
  const dictionary = dictionarySize ? readUint(bytes, pos, dictionarySize) : 0;
  if (dictionary === null) return null;
  pos += dictionarySize;
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag];
  let contentSize = null;
  if (contentSizeBytes) {
    contentSize = readUint(bytes, pos, contentSizeBytes);
    if (contentSize === null) return null;
    if (contentSizeBytes === 2) contentSize += 256;
  }
  pos += contentSizeBytes;
  if (singleSegment) window = contentSize;
  for (;;) {
    if (pos + 3 > bytes.length) return null;
    const header = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
    pos += 3;
    const type = (header >> 1) & 3;
    if (type === 3) return null;
    pos += type === 1 ? 1 : header >>> 3;
    if (pos > bytes.length) return null;
    if (header & 1) break;
  }
  if (checksum) pos += 4;
  if (pos > bytes.length) return null;
  return { contentSize, window, dictionary, length: pos };
}

/** The rule of §9.3 a frame breaks, or null; decoding is checked separately. */
function frameProblem(payload, rawLength) {
  const frame = zstdFrame(payload);
  if (!frame || frame.length !== payload.length) return 'zstd-frame';
  if (frame.dictionary !== 0) return 'zstd-dictionary';
  if (frame.window > MAX_WINDOW) return 'zstd-window';
  if (frame.contentSize !== null && frame.contentSize !== rawLength) return 'zstd-content-size';
  return null;
}

/** A zstd frame made of raw (or RLE) blocks, with no compressor: for vectors that break one rule. */
function handZstdFrame(content, { contentSize = 8, windowLog = 21, dictionary = 0, reserved = false, rle = false } = {}) {
  const sizeFlag = { 0: 0, 1: 0, 2: 1, 4: 2, 8: 3 }[contentSize];
  const single = contentSize === 1;
  const descriptor = (sizeFlag << 6) | (single ? 0x20 : 0) | (reserved ? 0x08 : 0) | (dictionary ? 0b10 : 0);
  const parts = [Uint8Array.from([...ZSTD_MAGIC, descriptor])];
  if (!single) parts.push(Uint8Array.of((windowLog - 10) << 3));
  if (dictionary) parts.push(u32le(dictionary).subarray(0, 2));
  if (contentSize === 1) parts.push(Uint8Array.of(content.length));
  if (contentSize === 2) parts.push(u32le(content.length - 256).subarray(0, 2));
  if (contentSize === 4) parts.push(u32le(content.length));
  if (contentSize === 8) parts.push(u64le(content.length));
  if (rle) {
    const header = (content.length << 3) | (1 << 1) | 1;
    parts.push(Uint8Array.of(header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff), content.subarray(0, 1));
  } else {
    for (let pos = 0; ; ) {
      const size = Math.min(content.length - pos, 128 * 1024);
      const last = pos + size === content.length ? 1 : 0;
      const header = (size << 3) | last;
      parts.push(Uint8Array.of(header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff));
      parts.push(content.subarray(pos, pos + size));
      pos += size;
      if (last) break;
    }
  }
  return concat(...parts);
}

// ---------------------------------------------------------------------------------------------
// Packs (remote-format.md §9)

const PACK_MAGIC = utf8('FOLIOPK1');
const END_MAGIC = utf8('FOLIOEND');
const TYPES = new Map([[1, 'blob'], [2, 'tree'], [3, 'commit']]);
const TYPE_CODES = { blob: 1, tree: 2, commit: 3 };
const RECORD_HEADER = 50;
const TRAILER = 48;
const MIN_PACK = 12 + RECORD_HEADER + 40 + TRAILER;
const MAX_OBJECT = 64 * 1024 * 1024;

const objectIdOf = (type, raw) => ({ blob: blobId, tree: treeId, commit: commitId })[type](raw);

/** A record of `type` holding `raw`, its payload `raw` itself or a zstd frame of it. */
const record = (type, raw, frame = null) => ({
  type: TYPE_CODES[type],
  flags: frame ? 1 : 0,
  id: objectIdOf(type, raw),
  rawLength: raw.length,
  payload: frame ?? raw,
});

/** A pack's bytes; the options break the layout on purpose for invalid vectors. */
function encodePack(records, options = {}) {
  const parts = [options.magic ?? PACK_MAGIC, u32le(options.version ?? 1)];
  let offset = 12;
  const index = [];
  for (const r of records) {
    const id = unhex(r.id.slice(3));
    index.push({ id, offset });
    parts.push(Uint8Array.of(r.type, r.flags), id, u64le(r.rawLength), u64le(r.payload.length), r.payload);
    offset += RECORD_HEADER + r.payload.length;
  }
  if (options.beforeIndex) parts.push(options.beforeIndex);
  let entries = index.sort((a, b) => compareBytes(a.id, b.id));
  if (options.index) entries = options.index(entries);
  for (const entry of entries) parts.push(entry.id, u64le(entry.offset));
  parts.push(u64le(options.count ?? entries.length), options.endMagic ?? END_MAGIC);
  const body = concat(...parts);
  return concat(body, blake3(body));
}

const packName = (bytes) => `${hex(bytes.subarray(bytes.length - 32))}.pack`;

/** Reads and verifies a whole pack (§11): { status: "ok" | "newer" | "invalid", reason, objects }. */
function readPack(bytes, fileName = null) {
  const invalid = (reason) => ({ status: 'invalid', reason });
  if (bytes.length < MIN_PACK) return invalid('too-short');
  if (!equalBytes(bytes.subarray(0, 8), PACK_MAGIC)) return invalid('magic');
  const version = readUint(bytes, 8, 4);
  if (version === 0) return invalid('version');
  if (version > 1) return { status: 'newer', reason: 'version' };
  const end = bytes.length - TRAILER;
  if (!equalBytes(bytes.subarray(end + 8, end + 16), END_MAGIC)) return invalid('end-magic');
  const hash = blake3(bytes.subarray(0, bytes.length - 32));
  if (!equalBytes(hash, bytes.subarray(bytes.length - 32))) return invalid('hash');
  if (fileName !== null && fileName !== `${hex(hash)}.pack`) return invalid('name');
  const count = readUint(bytes, end, 8);
  if (count === null || count < 1 || 40 * count > end - 12 - RECORD_HEADER) return invalid('index-size');
  const indexOffset = end - 40 * count;
  const index = new Map();
  for (let i = 0; i < count; i++) {
    const at = indexOffset + 40 * i;
    if (i > 0 && compareBytes(bytes.subarray(at - 40, at - 8), bytes.subarray(at, at + 32)) >= 0) {
      return invalid('index-order');
    }
    index.set(hex(bytes.subarray(at, at + 32)), readUint(bytes, at + 32, 8));
  }
  const objects = [];
  for (let offset = 12; offset < indexOffset; ) {
    if (offset + RECORD_HEADER > indexOffset) return invalid('record-bounds');
    const type = TYPES.get(bytes[offset]);
    const flags = bytes[offset + 1];
    const id = hex(bytes.subarray(offset + 2, offset + 34));
    const rawLength = readUint(bytes, offset + 34, 8);
    const storedLength = readUint(bytes, offset + 42, 8);
    if (!type) return invalid('record-type');
    if (flags > 1) return invalid('record-flags');
    if (rawLength === null || storedLength === null) return invalid('record-bounds');
    const payloadAt = offset + RECORD_HEADER;
    if (storedLength > indexOffset - payloadAt) return invalid('record-bounds');
    if (index.get(id) !== offset) return invalid('index-entry');
    index.delete(id);
    if (type !== 'blob' && rawLength > MAX_OBJECT) return invalid('object-size');
    const payload = bytes.subarray(payloadAt, payloadAt + storedLength);
    let raw = payload;
    if (flags === 1) {
      const problem = frameProblem(payload, rawLength);
      if (problem) return invalid(problem);
      try {
        raw = new Uint8Array(zstdDecompressSync(payload, { maxOutputLength: rawLength + 1 }));
      } catch {
        return invalid('zstd-data');
      }
    }
    if (raw.length !== rawLength) return invalid('raw-length');
    if (objectIdOf(type, raw) !== `b3:${id}`) return invalid('object-id');
    if (type !== 'blob') {
      let value;
      try {
        value = parseCanonical(raw);
      } catch (error) {
        if (error instanceof Reject) return invalid(`object-json:${error.reason}`);
        throw error;
      }
      const problem = type === 'tree' ? treeProblem(value) : commitProblem(value);
      if (problem) return invalid(`object-schema:${problem}`);
    }
    objects.push({ type, id: `b3:${id}`, offset, flags, raw });
    offset = payloadAt + storedLength;
  }
  return index.size === 0 ? { status: 'ok', objects } : invalid('index-entry');
}

// ---------------------------------------------------------------------------------------------
// Records of the remote store (remote-format.md §10, provisional until v0.3)

const RECORD_LIMITS = { format: 4 * 1024, head: 1024 * 1024, intent: 64 * 1024 * 1024 };
const RECORD_PATH = /^\.folio\/store\/(heads|intents)\/([0-9a-f]{32})\/([1-9][0-9]*)\.json$/;

const isPackRef = (ref) =>
  keysAre(ref, ['name', 'size']) &&
  typeof ref.name === 'string' &&
  /^[0-9a-f]{64}\.pack$/.test(ref.name) &&
  isSize(ref.size) &&
  ref.size >= MIN_PACK;

function formatProblem(value) {
  return keysAre(value, ['format_version', 'library_id']) && isId128(value.library_id) ? null : 'schema';
}

function headProblem(value) {
  const keys = ['device', 'format_version', 'head', 'intent', 'lamport', 'library_id', 'packs', 'seq', 'time'];
  if (!keysAre(value, keys)) return 'schema';
  if (!isDevice(value.device) || !isObjectId(value.head) || !isId128(value.library_id)) return 'schema';
  if (!isCount(value.seq) || !isCount(value.lamport) || !isCount(value.intent) || !isTime(value.time)) return 'schema';
  if (value.intent > value.seq) return 'intent';
  if (!Array.isArray(value.packs) || value.packs.length > 1000 || !value.packs.every(isPackRef)) return 'schema';
  return isStrictlyAscending(value.packs, (a, b) => compareUtf8(a.name, b.name)) ? null : 'order';
}

const WRITE_KEYS = new Map([
  ['write file', ['hash', 'kind', 'op', 'path']],
  ['write dir', ['kind', 'op', 'path']],
  ['delete file', ['kind', 'op', 'path']],
  ['delete dir', ['kind', 'op', 'path']],
]);
const compareWrites = (a, b) => compareUtf8(a.path, b.path) || (a.op === b.op ? 0 : a.op === 'delete' ? -1 : 1);

/** §10.4: a mirror path an intent may name, never Folio's private folders or `.folio` itself. */
function mirrorPathProblem(write) {
  if (pathProblem(write.path)) return 'path';
  const names = write.path.split('/');
  if (!sameName(names[0], '.folio')) return null;
  if (names[0] !== '.folio') return 'folio';
  if (names.length === 1) return write.op === 'write' && write.kind === 'dir' ? null : 'folio';
  return sameName(names[1], 'local') || sameName(names[1], 'store') ? 'folio' : null;
}

function intentProblem(value) {
  const spec = { required: ['device', 'format_version', 'head', 'library_id', 'seq', 'time', 'writes'], optional: ['base'] };
  if (!keysWithin(value, spec)) return 'schema';
  if (Object.hasOwn(value, 'base') && !isObjectId(value.base)) return 'schema';
  if (!isDevice(value.device) || !isObjectId(value.head) || !isId128(value.library_id)) return 'schema';
  if (!isCount(value.seq) || !isTime(value.time) || !Array.isArray(value.writes)) return 'schema';
  for (const write of value.writes) {
    const known = isObject(write) && typeof write.op === 'string' && typeof write.kind === 'string';
    const keys = known ? WRITE_KEYS.get(`${write.op} ${write.kind}`) : undefined;
    if (!keys || !keysAre(write, keys)) return 'write';
    if (Object.hasOwn(write, 'hash') && !isObjectId(write.hash)) return 'write';
    const problem = mirrorPathProblem(write);
    if (problem) return `write-${problem}`;
  }
  return isStrictlyAscending(value.writes, compareWrites) ? null : 'order';
}

/** §10.1: the file's path in the store names the device and the number the record states. */
function recordPathProblem(kind, value, path) {
  if (kind === 'format') return path === '.folio/store/FORMAT.json' ? null : 'path';
  const m = RECORD_PATH.exec(path);
  if (!m || m[1] !== (kind === 'head' ? 'heads' : 'intents')) return 'path';
  return m[2] === value.device.id && Number(m[3]) === value.seq ? null : 'path';
}

/** A remote record (§11): { status: "ok" | "newer" | "invalid", reason }. */
function readRecord(kind, bytes, path) {
  const invalid = (reason) => ({ status: 'invalid', reason });
  if (bytes.length > RECORD_LIMITS[kind]) return invalid('size');
  let document;
  try {
    document = parseJson(bytes);
  } catch (error) {
    if (error instanceof Reject) return invalid(`json:${error.reason}`);
    throw error;
  }
  const stated = isObject(document) && document.format_version instanceof Num ? document.format_version.raw : null;
  if (stated === null || !/^[1-9][0-9]*$/.test(stated)) return invalid('format_version');
  if (stated !== '1') return { status: 'newer', reason: 'format_version' };
  let value;
  try {
    value = parseCanonical(bytes);
  } catch (error) {
    if (error instanceof Reject) return invalid(`json:${error.reason}`);
    throw error;
  }
  const problem =
    { format: formatProblem, head: headProblem, intent: intentProblem }[kind](value) ??
    recordPathProblem(kind, value, path);
  return problem ? invalid(problem) : { status: 'ok' };
}

// ---------------------------------------------------------------------------------------------
// The example library and its history

const LIBRARY_ID = '48ffdfb335860f2c15c8bccf2a90e720';
const DEVICE_A = { id: '8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c', name: 'G16' };
const DEVICE_B = { id: '3f2c9a7d1e5b40c8a6d2f9e1b7c3a5d0', name: '台式机' };
const COURSE = '2026 秋/线性代数';

const LIBRARY_JSON = `{
  "format_version": 2,
  "id": "${LIBRARY_ID}",
  "name": "Sirui's library",
  "versioning": {
    "text_extensions": ["md", "txt"],
    "text_max_size": 10485760,
    "word_extensions": ["docx"]
  }
}
`;
const TAGS_JSON = `{
  "format_version": 2,
  "tags": {
    "homework": {
      "color": "orange",
      "name": "Homework",
      "order": 3
    },
    "notes": {
      "color": "blue",
      "name": "Notes",
      "order": 1
    }
  }
}
`;
/** The course's metadata, its homework file at `homeworkPath` (which sorts first either way). */
const courseJson = (homeworkPath) => `{
  "format_version": 2,
  "course": {
    "abbr": "线代",
    "archived": false,
    "code": "MAT232",
    "color": "blue",
    "order": 1
  },
  "tags": {
    "${homeworkPath}": ["homework"],
    "第3讲 特征值.md": ["notes"]
  }
}
`;
const docx = (length, seed) =>
  concat(utf8('PK\u0003\u0004'), Uint8Array.from({ length: length - 4 }, (_, i) => (i * seed + 7) % 256));

/** library.json's rules above: md and txt up to 10 MiB, every docx, every metadata file. */
function stored(path, size) {
  if (path.startsWith('.folio/')) return true;
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
  return (['md', 'txt'].includes(extension) && size <= 10485760) || extension === 'docx';
}

const FILES_1 = {
  '.folio/library.json': utf8(LIBRARY_JSON),
  '.folio/tags.json': utf8(TAGS_JSON),
  '.folio/ignore': utf8('*.log\n'),
  '.folio/meta/2026 秋/线性代数.json': utf8(courseJson('作业/hw2.pdf')),
  [`${COURSE}/第3讲 特征值.md`]: utf8('# 第3讲 特征值\n\n- 特征多项式\n'),
  [`${COURSE}/作业/hw2.pdf`]: concat(utf8('%PDF-1.7\n'), pattern(2039)),
  [`${COURSE}/报告.docx`]: docx(1024, 31),
  [`${COURSE}/Lectures/L1.md`]: utf8('# Lecture 1\n'),
  [`${COURSE}/Lectures/L2.md`]: utf8('# Lecture 2\n'),
  '2026 秋/Ａ.txt': utf8('Fullwidth A sorts after 线 and before 😀 by UTF-8 bytes.\n'),
  '2026 秋/😀.md': utf8('UTF-16 order would put this name before Ａ.txt.\n'),
  'B.md': utf8('Upper-case B sorts before a.\n'),
  'a.md': utf8('Lower-case a.\n'),
};
const EMPTY_DIRS = [`${COURSE}/Projects`];

/** Files and empty folders → the tree objects (new ones in `trees`, bottom-up in `order`) and the root id. */
function buildTrees(files, trees) {
  const node = () => ({ files: new Map(), dirs: new Map() });
  const root = node();
  const dirAt = (names) => names.reduce((dir, name) => {
    if (!dir.dirs.has(name)) dir.dirs.set(name, node());
    return dir.dirs.get(name);
  }, root);
  for (const [path, bytes] of Object.entries(files)) {
    const names = path.split('/');
    dirAt(names.slice(0, -1)).files.set(names.at(-1), bytes);
  }
  for (const dir of EMPTY_DIRS) dirAt(dir.split('/'));
  const order = [];
  const write = (dir, path) => {
    const entries = [];
    for (const [name, child] of dir.dirs) {
      entries.push({ hash: write(child, path ? `${path}/${name}` : name), kind: 'dir', name });
    }
    for (const [name, bytes] of dir.files) {
      const filePath = path ? `${path}/${name}` : name;
      entries.push({ hash: blobId(bytes), kind: 'file', name, size: bytes.length, stored: stored(filePath, bytes.length) });
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    const bytes = canonical({ entries });
    const id = treeId(bytes);
    if (!trees.has(id)) {
      trees.set(id, { entries });
      order.push({ path, id, bytes });
    }
    return id;
  };
  return { root: write(root, ''), order };
}

/** The change records from `parent` to `tree` (§8), given what moved: a Map from new path to old. */
function changesBetween(parent, tree, moves = new Map()) {
  const differs = (path) => !parent.has(path) || !tree.has(path) || !sameEntry(parent.get(path), tree.get(path));
  const fromSide = [...parent.keys()].filter(differs);
  const toSide = new Set([...tree.keys()].filter(differs));
  const carried = new Set();
  for (const [to, from] of moves) {
    if (tree.get(to)?.kind !== 'dir') continue;
    for (const path of fromSide) {
      const moved = `${to}/${path.slice(from.length + 1)}`;
      if (path.startsWith(`${from}/`) && toSide.has(moved) && sameEntry(parent.get(path), tree.get(moved))) {
        carried.add(path).add(moved);
      }
    }
  }
  const records = [];
  const modified = new Set();
  for (const path of toSide) {
    if (carried.has(path)) continue;
    const entry = tree.get(path);
    const from = moves.get(path);
    const side = entry.kind === 'file' ? { new: sideOf(entry) } : {};
    if (from !== undefined) {
      records.push({ from, kind: entry.kind, op: 'move', path, ...side, ...(entry.kind === 'file' && { old: sideOf(parent.get(from)) }) });
    } else if (parent.get(path)?.kind === 'file' && entry.kind === 'file') {
      records.push({ kind: 'file', ...side, old: sideOf(parent.get(path)), op: 'modify', path });
      modified.add(path);
    } else {
      records.push({ kind: entry.kind, op: 'add', path, ...side });
    }
  }
  const movedFrom = new Set(moves.values());
  for (const path of fromSide) {
    if (carried.has(path) || movedFrom.has(path) || modified.has(path)) continue;
    const entry = parent.get(path);
    records.push({ kind: entry.kind, op: 'delete', path, ...(entry.kind === 'file' && { old: sideOf(entry) }) });
  }
  return records.sort(compareChanges);
}

function buildHistory() {
  const trees = new Map();
  const contents = new Map();
  const commits = [];
  const commitOf = (name, value, order) => {
    const bytes = canonical(value);
    const entry = { name, commit: value, bytes, id: commitId(bytes), flat: flatten(value.tree, trees), order };
    commits.push(entry);
    return entry;
  };
  const snapshot = (files) => {
    for (const bytes of Object.values(files)) contents.set(blobId(bytes), bytes);
    return buildTrees(files, trees);
  };

  // c1: the library's first commit.
  const t1 = snapshot(FILES_1);
  const c1 = commitOf('c1', {
    changes: changesBetween(new Map(), flatten(t1.root, trees)),
    device: DEVICE_A,
    kind: 'commit',
    summary: 'Start history',
    time: '2026-10-03T21:11:00Z',
    tree: t1.root,
  }, t1.order);

  // c2, later that day: an edit; a file moved out of a folder that then goes; tags that follow
  // the move; a new Word version; a deletion; a folder renamed, with one file in it edited.
  const files2 = { ...FILES_1 };
  files2[`${COURSE}/第3讲 特征值.md`] = utf8('# 第3讲 特征值\n\n- 特征多项式\n- 特征值的几何意义\n');
  files2[`${COURSE}/hw2.pdf`] = files2[`${COURSE}/作业/hw2.pdf`];
  delete files2[`${COURSE}/作业/hw2.pdf`];
  files2['.folio/meta/2026 秋/线性代数.json'] = utf8(courseJson('hw2.pdf'));
  files2[`${COURSE}/报告.docx`] = docx(1536, 57);
  delete files2['a.md'];
  files2[`${COURSE}/讲义/L1.md`] = files2[`${COURSE}/Lectures/L1.md`];
  files2[`${COURSE}/讲义/L2.md`] = utf8('# Lecture 2\n\nEigenvectors.\n');
  delete files2[`${COURSE}/Lectures/L1.md`];
  delete files2[`${COURSE}/Lectures/L2.md`];
  const t2 = snapshot(files2);
  const c2 = commitOf('c2', {
    changes: changesBetween(c1.flat, flatten(t2.root, trees), new Map([
      [`${COURSE}/hw2.pdf`, `${COURSE}/作业/hw2.pdf`],
      [`${COURSE}/讲义`, `${COURSE}/Lectures`],
      [`${COURSE}/讲义/L2.md`, `${COURSE}/Lectures/L2.md`],
    ])),
    device: DEVICE_A,
    kind: 'commit',
    parent: c1.id,
    summary: 'MAT232: update 3 files, move 2 items; Library: delete 1 file',
    time: '2026-10-03T23:30:00Z',
    tree: t2.root,
  }, t2.order);

  // c3: an iPad edit that device B imported on top of c1, then rebased onto c2.
  const note = utf8('在 iPad 上写的笔记\n');
  const importOf = (parent, files) => {
    const scratch = new Map(trees);
    const t = buildTrees(files, scratch);
    return {
      tree: t,
      scratch,
      commit: {
        body: 'Imported 1 file edited on "iPad".\n\t- path: 2026 秋\\线性代数 / 😀',
        changes: changesBetween(parent.flat, flatten(t.root, scratch)),
        device: DEVICE_B,
        kind: 'import',
        parent: parent.id,
        summary: 'Changes from iCloud',
        time: '2026-10-05T14:00:00Z',
        tree: t.root,
      },
    };
  };
  const before = importOf(c1, { ...FILES_1, [`${COURSE}/iPad 笔记.txt`]: note });
  const t3 = snapshot({ ...files2, [`${COURSE}/iPad 笔记.txt`]: note });
  const c3 = commitOf('c3', {
    ...importOf(c2, { ...files2, [`${COURSE}/iPad 笔记.txt`]: note }).commit,
    rebased_from: commitId(canonical(before.commit)),
  }, t3.order);

  // c4: thinning removes the first Word version (2026-10-03 kept its last, from c2).
  const c4 = commitOf('c4', {
    device: DEVICE_A,
    kind: 'prune',
    parent: c3.id,
    pruned: [blobId(FILES_1[`${COURSE}/报告.docx`])],
    time: '2026-12-10T03:00:00Z',
    tree: c3.commit.tree,
  }, []);

  // c5: the user restores that Word version and commits it; the blob comes back.
  const files5 = { ...files2, [`${COURSE}/iPad 笔记.txt`]: note, [`${COURSE}/报告.docx`]: FILES_1[`${COURSE}/报告.docx`] };
  const t5 = snapshot(files5);
  const c5 = commitOf('c5', {
    changes: changesBetween(c4.flat, flatten(t5.root, trees)),
    device: DEVICE_A,
    kind: 'commit',
    parent: c4.id,
    summary: 'MAT232: restore 报告.docx',
    time: '2026-12-11T10:00:00Z',
    tree: t5.root,
  }, t5.order);

  for (const c of commits) {
    const parent = commits.find((p) => p.id === c.commit.parent)?.commit ?? null;
    const problem = commitProblem(c.commit) ?? commitContextProblem(c.commit, parent, trees);
    if (problem) throw new Error(`commit ${c.name}: ${problem}`);
  }
  return { trees, contents, commits, c: { c1, c2, c3, c4, c5 } };
}

// ---------------------------------------------------------------------------------------------
// zstd frames, made once (see the header comment) and checked by decoding them here

// Made with Node 24.19.0's libzstd at level 3, with the content size and without a checksum,
// except `blob hello with checksum`.
const FRAMES = {
  'tree c2 2026 秋/线性代数':
    '28b52ffd608f01050c0016dd552d9029e90df9ffb658c75b443cf502924afe8cfa491a4b48fb3f8129c9e460f5fdac9d644a524a2911e6587766054a0048004600ed041e9000a79c2fb0e3140769b453ae391a054e71a8612684fe55d151cb129713a756ce9ad8d184b98dae92fa658a4a752e949fda7fd862ab2076ca3116661c8300e5166f40220e3f869c9feccd5ae38b02bf72cd218fc8728a95f028e70a1acb29ee9b81c541c07085c6ff4a99ba9d4ec869f1ca7fe5b8c9f89f4fc68f6c11d7b2b47cd5727c4e835a99d7f26f85e4964887bd69c5ef8bdadb68da3aaae132ed3599f67f6d8fc8ccb5f5014824913209fad1160e0d260e1c24b0837ed27fd236aef9befb6e58f955d5b33f4921ea5447ddbb8ab54ddd199201926b9088100131613f29226d89963adaef8cdfa066ef5a3cfefda8f1626830f526caa6ffcbaf1622bb2eccb6b078b060c200c244a261024004c404f4f030d12891b275baf535b3b1e90d0019c401003663b12b608cc60080e661ba839d21a67000c03386492207981f62d0632e9c01',
  'commit c2':
    '28b52ffd60c3075d1f008a46280c35506fd201cd3b33b3450291c6a358cbe57b819835fbe06f847293a6f8d898924c824db793f10e912499a44c49a6644fbe4dccccec01ca00a100ab002d69be7158a006191718428064300172d14c9a8ae5f28d87e4a3d9b06014587cb8a0420309100e1154a01811725181434844a1832e38e3950b0b45c3f21619e66824cd83a7344ba599341cabd4cf2afa4a4cb5b17f2f5295123e1eb6c7af37d91ff11da6b44ad95ee641e7cb9b86a5917c78c72533699a5f2c194c234188268d43a0609af3c9a39cb6516d62223bae58af5af7b5d823fad7f6c7e67a99ee5f739d7d4c89ac1364cda4c9c07046e331691af84623695c83f2cda4691b94058dc7814983f1041b9cd18d470b75ebab528daf11fbebc4ef7bb4b7cfb585523bebda6b5efbbfb63f87996b6b076d6916142ca4d8404145a2738db7aa3955a65dd4bf4fab59d7f236376ee8b730cf0fd9a2fc7379e724e34d6e6dc80ad331741ce57f6a9fab7adf7d3f567ed5f4ec51a683add4b17b37b1b6d9ad58bd627f6b2fe31ade9a0ba539038c06ffca83bf526537d47938172ff59ffc6c9e3f7ac5f8cf5a96cb372d3fcfeab095792dff4b59dfb5628489316dac58ba3de851fb1cd4d7cdb6de14dd316bbed425c4bca57b2bbc86586752dd8e35756d6fc63df68718fbcf6c850ed3c9ee76f4dbd6a414f5f2e5abf21bd7e1a31f1eca5dee5fec59536bdad6794e2c3923ee63792add9ee6e955847131410408080f2b307ee9c8b463b48a45890829249c482162424804848715d8a14388f2f57397f8fe14da4e8db2edda6da95142b42df1a3a574172ac7f6ba1e531b63af142a0b1f0d72bfca466c134faa7af46e9918265c54c914637b8bf9aec314723bf6b88e2976d5afba27c8fc62e09cc9c109a20278009c0340c93492e62291c9830b5f180523120053f10c2582221109268211cf70e3e8884c10a20202083493e6c1852b958e5c967e21b65778ba17695ad495d0761ed7c3d6f1d3e999b5a4fe156a79b02d66a6791233b3e1970ca552b1f447a36e403369bcc21bdb8edf2346965adb9e63bee264a82d8a378581b74682e0836f3555ca472d6d442b4ca8312142ca1881042212d2484022f140c288426b0f12c06324c6c02cc6088c0019680c62c6e299190b5c3780148ab9fd9bc38755d5a77fe1666a9caf01181a9d067c05b77fb88ed4cfea705b0ca389bc52806100cf2d0347fb52039dce0877d34a9b48c80b43071e524d8859c300bbda7d65d6714caa6cd4032983e503791d0df52d26f99a3f7c1ea4ca6f0eca987d87efab204e3b73586ee4a90188c2384c5302a010cc57e3f06d593e04b9d0f753503d44025a89a90bf06bd29ed5be0b54aea4a2b63daae7e3d6e9b3a432cc873c37e3a9ccc194541c99bdbaa10a',
  'commit c3':
    '28b52ffd609f019d0f00d6a26c36606bd20614e7964b92303a4259724a017675ea285cc3cb627c9282255448b14d925c5356e92d1c0fde165ad9bd53a6d903250141081c6a005c005a0070d96256cd8b61dac6d64b519f422410a2164f154c4717d5a7ee3408d482c053c93ce04088d4452f224ce8a044281a1038285cd09071c19161a3e3f17090d1a1b0de561e248214ca43f4701e10fa7018a0d187e23c8d4f654e34afb0e233821e8a08007dcac09fa816012df274dfce202357c535d91b74b23f35533609a6eb5260a2d1820842c3028707153a9488087daa8bba437d4af1e832991550f4d427f444125d563f9d0d1a892ebad43e4b876d76f4b5b1257f35995511b65cb632712f76fb11ae043fcb94a76618d5fa33ed23fb66d125c7fd91077a033e25304e48179593ad2fb7dc328b31b99c8c2a46f9ec97b7f5eb608abcd63a055d2dd74bc2d9ed17ba67d2738c9c0935cb443724706060d8a081b1419fce087474d1f505930c13658e71f715cb8ece9b5fb54bc5dbcca6f72ffe1561b7e49c4d6fcb5d639699236bfe97e284225d74c0eedb7d8a05ac7d587e68a28a6742a2511409084622152d99d9acbd844bb9c4dbf619839ddc3af31f5d6b161600071641c20a81b06b3becb45662d8535ec33248bc97dabb1f2c46ecdb90c20ec4b65d03d807a12df3b215655b6567fcf28c66df5998450b1189603a01',
  'blob hello with checksum': '28b52ffd240631000068656c6c6f0a5388bd91',
};
const missingFrames = [];

function frameFor(name, raw, { checksum = false } = {}) {
  if (FRAMES[name] === undefined) {
    const made = zstdCompressSync(raw, {
      params: {
        [zlib.ZSTD_c_compressionLevel]: 3,
        [zlib.ZSTD_c_contentSizeFlag]: 1,
        [zlib.ZSTD_c_checksumFlag]: checksum ? 1 : 0,
      },
      pledgedSrcSize: raw.length,
    });
    missingFrames.push(`  '${name}':\n    '${hex(made)}',`);
    return new Uint8Array(made);
  }
  const bytes = unhex(FRAMES[name]);
  if (frameProblem(bytes, raw.length)) throw new Error(`frozen frame ${name} breaks the frame rules`);
  if (!equalBytes(zstdDecompressSync(bytes), raw)) throw new Error(`frozen frame ${name} decodes wrongly`);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Vector files

/** A long string for a vector, given by a pattern instead of spelled out. */
function repeated({ repeat, count, then = '' }) {
  return { value_pattern: { repeat, count, then }, value: repeat.repeat(count) + then };
}

function hashesVectors() {
  const blobs = [
    ['empty', new Uint8Array()],
    ['abc', utf8('abc')],
    ['chinese-text', utf8('# 第3讲 特征值\n\n- 特征多项式\n')],
  ].map(([name, bytes]) => ({ name, input_hex: hex(bytes), blob_id: blobId(bytes) }));
  const patterned = [1, 63, 64, 65, 1023, 1024, 1025, 2048, 2049, 3072, 3073, 4097, 102400, 1048577].map(
    (length) => ({ name: `pattern-${length}`, input_pattern: { length }, blob_id: blobId(pattern(length)) }),
  );
  const emptyTree = canonical({ entries: [] });
  const derive = [
    ['empty-tree', TREE_CONTEXT, { material_hex: hex(emptyTree) }, emptyTree],
    ['empty-material-tree', TREE_CONTEXT, { material_hex: '' }, new Uint8Array()],
    ['empty-tree-bytes-as-commit', COMMIT_CONTEXT, { material_hex: hex(emptyTree) }, emptyTree],
    ['pattern-1025-tree', TREE_CONTEXT, { material_pattern: { length: 1025 } }, pattern(1025)],
  ].map(([name, context, input, material]) => ({ name, context, ...input, output: hex(deriveKey(context, material)) }));
  return {
    description:
      'BLAKE3 in hash mode (content hashes and blob ids) and in derive_key mode (tree and commit ids). ' +
      'input_pattern and material_pattern: the bytes i mod 251 for i = 0 .. length - 1. ' +
      'derive_key outputs are 32 bytes.',
    blob_ids: [...blobs, ...patterned],
    derive_key: derive,
    domain_separation: {
      note: 'The same bytes as a blob, a tree and a commit have three different ids.',
      bytes_hex: hex(emptyTree),
      blob_id: blobId(emptyTree),
      tree_id: treeId(emptyTree),
      commit_id: commitId(emptyTree),
    },
  };
}

function canonicalJsonVectors() {
  const nest = (levels) => '{"a":'.repeat(levels - 1) + '{}' + '}'.repeat(levels - 1);
  const valid = [
    ['order-and-nesting', '{"a":[true,false,"x"],"b":1,"c":{"y":0,"z":""}}'],
    ['escapes', '{"s":"quote\\" backslash\\\\ \\b\\f\\n\\r\\t nul\\u0000 us\\u001f del\u007f slash/ ls  中文 😀"}'],
    ['largest-integer', '{"n":9007199254740991}'],
    ['empty-containers', '{"a":{},"b":[]}'],
    ['keys-by-utf8-bytes', '{"B":1,"_":2,"a":3,"é":4}'],
    ['nested-16-levels', nest(16)],
  ];
  const invalid = [
    ['whitespace', utf8('{"a": 1}'), 'noncanonical'],
    ['key-order', utf8('{"b":1,"a":2}'), 'noncanonical'],
    ['escaped-slash', utf8('{"a":"\\/"}'), 'noncanonical'],
    ['upper-case-escape', utf8('{"a":"\\u001F"}'), 'noncanonical'],
    ['unneeded-escape-ascii', utf8('{"a":"\\u0041"}'), 'noncanonical'],
    ['unneeded-escape-cjk', utf8('{"a":"\\u7ebf"}'), 'noncanonical'],
    ['long-escape-for-newline', utf8('{"a":"\\u000a"}'), 'noncanonical'],
    ['escaped-del', utf8('{"a":"\\u007f"}'), 'noncanonical'],
    ['trailing-newline', utf8('{"a":1}\n'), 'noncanonical'],
    ['byte-order-mark', concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('{"a":1}')), 'json'],
    ['leading-zero', utf8('{"a":01}'), 'json'],
    ['negative', utf8('{"a":-1}'), 'number'],
    ['negative-zero', utf8('{"a":-0}'), 'number'],
    ['fraction', utf8('{"a":1.0}'), 'number'],
    ['exponent', utf8('{"a":1e3}'), 'number'],
    ['integer-too-large', utf8('{"a":9007199254740992}'), 'number'],
    ['null', utf8('{"a":null}'), 'null'],
    ['duplicate-key', utf8('{"a":1,"a":1}'), 'duplicate-key'],
    ['lone-surrogate', utf8('{"a":"\\ud800"}'), 'lone-surrogate'],
    ['raw-control-character', utf8('{"a":"\t"}'), 'json'],
    ['invalid-utf8', concat(utf8('{"a":"'), Uint8Array.of(0xc0, 0xaf), utf8('"}')), 'utf8'],
    ['truncated', utf8('{"a":1'), 'json'],
    ['nested-17-levels', utf8(nest(17)), 'depth'],
  ];
  const documents = [];
  for (const [name, text] of valid) {
    parseCanonical(utf8(text));
    documents.push({ name, canonical: true, text, hex: hex(utf8(text)) });
  }
  for (const [name, bytes, reason] of invalid) {
    let got = null;
    try {
      parseCanonical(bytes);
    } catch (error) {
      got = error.reason;
    }
    if (got !== reason) throw new Error(`canonical-json ${name}: expected ${reason}, got ${got}`);
    documents.push({ name, canonical: false, reason, hex: hex(bytes) });
  }
  const encode = [
    { name: 'sorts-keys-and-escapes', value: { z: [1, 0, 9007199254740991], a: 'tab\tquote"', B: { y: false, x: true } } },
    { name: 'unicode-stays-raw', value: { name: '2026 秋/线性代数/第3讲 特征值.md', emoji: '😀', ls: ' ' } },
  ].map((item) => ({ ...item, canonical_hex: hex(canonical(item.value)) }));
  return {
    description:
      'Documents to read (hex: the exact bytes, authoritative; text: the same bytes for reading) and ' +
      'values to write. A reader accepts a document only if it is canonical; reason names the first ' +
      'rule broken (informative). encode: the canonical bytes of each value.',
    documents,
    encode,
  };
}

function valuesVectors() {
  const names = [
    ['2026 秋', null], ['第3讲 特征值.pptx', null], ['.gitignore', null], [' leading space', null],
    ['CONSOLE', null], ['COM10', null], ['LPT', null], ['NUL-notes.md', null], ['résumé.docx', null],
    ['a\u007fb', null], ['Files & Backup.md', null], [{ repeat: '😀', count: 127, then: 'a' }, null],
    [{ repeat: 'a', count: 255 }, null], ['', 'empty'], ['.', 'dotName'], ['..', 'dotName'],
    ['a/b', 'invalidCharacter'], ['a\\b', 'invalidCharacter'], ['a:b', 'invalidCharacter'],
    ['a?b', 'invalidCharacter'], ['a*b', 'invalidCharacter'], ['a"b', 'invalidCharacter'],
    ['a<b', 'invalidCharacter'], ['a>b', 'invalidCharacter'], ['a|b', 'invalidCharacter'],
    ['a\u0000b', 'invalidCharacter'], ['a\tb', 'invalidCharacter'], ['a\u001fb', 'invalidCharacter'],
    ['notes.', 'trailingDotOrSpace'], ['notes ', 'trailingDotOrSpace'], ['CON', 'reservedName'],
    ['con.txt', 'reservedName'], ['CON .txt', 'reservedName'], ['Nul.tar.gz', 'reservedName'],
    ['CONIN$', 'reservedName'], ['conout$.log', 'reservedName'], ['COM0', 'reservedName'],
    ['lpt9.md', 'reservedName'], ['COM¹', 'reservedName'], ['LPT³.txt', 'reservedName'],
    [{ repeat: '😀', count: 128 }, 'tooLong'], [{ repeat: 'a', count: 256 }, 'tooLong'],
    ['résumé.docx', 'notNfc'],
  ].map(([given, rule]) => {
    const item = typeof given === 'string' ? { value: given } : repeated(given);
    const got = nameProblem(item.value);
    if (got !== rule) throw new Error(`name ${JSON.stringify(item.value).slice(0, 40)}: expected ${rule}, got ${got}`);
    if (rule === 'notNfc' && isNfc(item.value)) throw new Error('the NFD vector is NFC');
    const out = item.value_pattern ? { value_pattern: item.value_pattern } : { value: item.value, hex: hex(utf8(item.value)) };
    return { ...out, valid: rule === null, ...(rule && { rule }) };
  });
  const longPath = (last) => repeated({ repeat: `${'a'.repeat(200)}/`, count: 162, then: 'a'.repeat(last) });
  const paths = [
    ['2026 秋/线性代数/第3讲 特征值.pptx', null], ['a', null], ['', 'empty'], ['/a', 'empty'],
    ['a/', 'empty'], ['a//b', 'empty'], ['a/../b', 'dotName'], ['a./b', 'trailingDotOrSpace'],
    [longPath(205), null], [longPath(206), 'pathTooLong'],
  ].map(([given, rule]) => {
    const item = typeof given === 'string' ? { value: given } : given;
    const got = pathProblem(item.value);
    if (got !== rule) throw new Error(`path: expected ${rule}, got ${got}`);
    const out = item.value_pattern ? { value_pattern: item.value_pattern } : { value: item.value };
    return { ...out, valid: rule === null, ...(rule && { rule }) };
  });
  const check = (list, test) =>
    list.map(([given, valid, note]) => {
      const item = typeof given === 'string' ? { value: given } : repeated(given);
      if (test(item.value) !== valid) throw new Error(`value ${JSON.stringify(item.value).slice(0, 40)}: expected ${valid}`);
      const out = item.value_pattern ? { value_pattern: item.value_pattern } : { value: item.value };
      return { ...out, valid, ...(note && { note }) };
    });
  return {
    description:
      'Value rules of §6. A value_pattern stands for repeat × count followed by then. Names: rule ' +
      'is the first broken rule, in the order of §6.4 (informative).',
    names,
    paths,
    times: check([
      ['2026-10-03T21:11:00Z', true], ['1970-01-01T00:00:00Z', true], ['9999-12-31T23:59:59Z', true],
      ['2028-02-29T12:00:00Z', true], ['2026-02-29T12:00:00Z', false, 'not a leap year'],
      ['2100-02-29T12:00:00Z', false, 'not a leap year'], ['2026-10-03T21:11:00.5Z', false, 'fraction'],
      ['2026-10-03T21:11:00+00:00', false, 'offset'], ['2026-10-03 21:11:00Z', false, 'space'],
      ['2026-10-03T24:00:00Z', false, 'hour 24'], ['2026-10-03T23:59:60Z', false, 'leap second'],
      ['1969-12-31T23:59:59Z', false, 'before 1970'], ['2026-1-03T21:11:00Z', false, 'one-digit month'],
    ], isTime),
    display_names: check([
      ['G16', true], ['台式机', true], ['Sirui’s Surface', true], [{ repeat: 'x', count: 128 }, true],
      [{ repeat: 'x', count: 129 }, false], ['', false], [' G16', false], ['G16 ', false],
      ['G16　', false, 'ideographic space'], ['a\nb', false], ['a\u0085b', false, 'NEL is a control character'],
    ], isDisplayName),
    summaries: check([
      ['MAT232: add lecture 5 slides', true], [{ repeat: 'x', count: 256 }, true], [{ repeat: 'x', count: 257 }, false],
      ['', false], ['line\nbreak', false], [' padded', false], ['tab\tinside', false],
    ], isSummary),
    bodies: check([
      ['- one\n- two', true], ['\tindented\n\n  second paragraph', true], [{ repeat: 'x', count: 16384 }, true],
      [{ repeat: 'x', count: 16385 }, false], ['', false], ['\nstarts with a line break', false],
      ['ends with a line break\n', false], ['ends with a space ', false], ['carriage\r\nreturn', false],
      ['bell\u0007', false],
    ], isBody),
    object_ids: check([
      [`b3:${'0'.repeat(64)}`, true], [`b3:${'A'.repeat(64)}`, false], [`b3:${'0'.repeat(63)}`, false],
      [`B3:${'0'.repeat(64)}`, false], ['0'.repeat(64), false],
    ], isObjectId),
    ids_128: check([[LIBRARY_ID, true], [LIBRARY_ID.toUpperCase(), false], [LIBRARY_ID.slice(1), false]], isId128),
  };
}

function objectsVectors(history) {
  const { contents, commits } = history;
  const blobs = new Map();
  for (const { name, flat } of commits) {
    for (const [path, entry] of flat) {
      if (entry.kind === 'file' && !blobs.has(entry.hash)) {
        const bytes = contents.get(entry.hash);
        blobs.set(entry.hash, { content_hash: entry.hash, first_commit: name, first_path: path, size: bytes.length, stored: entry.stored, hex: hex(bytes) });
      }
    }
  }
  const trees = commits.flatMap(({ name, order }) =>
    order.map(({ path, id, bytes }) => ({ first_commit: name, path, id, text: Buffer.from(bytes).toString('utf8'), hex: hex(bytes) })),
  );
  const flattened = Object.fromEntries(commits.map(({ commit, flat }) => [commit.tree, Object.fromEntries(flat)]));

  const fileEntry = (name) => ({ hash: blobId(utf8('x')), kind: 'file', name, size: 1, stored: true });
  const dirEntry = (name) => ({ hash: treeId(canonical({ entries: [] })), kind: 'dir', name });
  const invalidTrees = [
    ['unsorted', [fileEntry('b'), fileEntry('a')], 'order'],
    ['utf16-order', [fileEntry('😀.md'), fileEntry('Ａ.txt')], 'order'],
    ['duplicate-name', [fileEntry('a'), dirEntry('a')], 'order'],
    ['dot-dot', [dirEntry('..')], 'name:dotName'],
    ['slash', [fileEntry('a/b')], 'name:invalidCharacter'],
    ['reserved', [fileEntry('con.txt')], 'name:reservedName'],
    ['trailing-space', [fileEntry('a ')], 'name:trailingDotOrSpace'],
    ['not-nfc', [fileEntry('résumé.docx')], 'name:notNfc'],
    ['unknown-field', [{ ...fileEntry('a'), mode: 420 }], 'schema'],
    ['dir-with-size', [{ ...dirEntry('a'), size: 0 }], 'schema'],
    ['file-without-stored', [{ hash: blobId(utf8('x')), kind: 'file', name: 'a', size: 1 }], 'schema'],
    ['unknown-kind', [{ hash: blobId(utf8('x')), kind: 'link', name: 'a' }], 'schema'],
    ['upper-case-hash', [{ ...fileEntry('a'), hash: `b3:${'A'.repeat(64)}` }], 'schema'],
  ].map(([name, entries, reason]) => {
    const value = { entries };
    const got = treeProblem(value);
    if (got !== reason) throw new Error(`invalid tree ${name}: expected ${reason}, got ${got}`);
    const bytes = canonical(value);
    return { name, kind: 'tree', reason, id: treeId(bytes), text: Buffer.from(bytes).toString('utf8'), hex: hex(bytes) };
  });
  // A small commit with one modify and one move, to break one rule at a time.
  const side = (text) => ({ hash: blobId(utf8(text)), size: text.length, stored: true });
  const base = {
    changes: [
      { kind: 'file', new: side('b'), old: side('a'), op: 'modify', path: 'notes.md' },
      { from: 'old.md', kind: 'file', new: side('c'), old: side('c'), op: 'move', path: 'renamed.md' },
    ],
    device: DEVICE_A,
    kind: 'commit',
    parent: commits[0].id,
    summary: 'Library: update 1 file, move 1 file',
    time: '2026-10-04T08:00:00Z',
    tree: commits[1].commit.tree,
  };
  const prune = commits[3].commit;
  const invalidCommits = [
    ['unknown-kind', { ...base, kind: 'merge' }, 'schema'],
    ['kind-in-an-array', { ...base, kind: ['commit'] }, 'schema'],
    ['kind-names-a-property', { ...base, kind: 'constructor' }, 'schema'],
    ['unknown-field', { ...base, author: 'Sirui' }, 'schema'],
    ['joined-keys', { ...base, changes: [{ ...base.changes[0], new: undefined, old: undefined, 'new,old': 0 }].map(({ new: _n, old: _o, ...rest }) => rest).concat(base.changes[1]) }, 'change:schema'],
    ['empty-summary', { ...base, summary: '' }, 'summary'],
    ['summary-line-break', { ...base, summary: 'two\nlines' }, 'summary'],
    ['body-trailing-line-break', { ...base, body: 'details\n' }, 'body'],
    ['body-carriage-return', { ...base, body: 'a\r\nb' }, 'body'],
    ['time-offset', { ...base, time: '2026-10-04T08:00:00+00:00' }, 'schema'],
    ['empty-changes', { ...base, changes: [] }, 'schema'],
    ['unsorted-changes', { ...base, changes: [...base.changes].reverse() }, 'order'],
    ['modify-without-change', { ...base, changes: [{ ...base.changes[0], new: base.changes[0].old }, base.changes[1]] }, 'change:schema'],
    ['move-in-place', { ...base, changes: [base.changes[0], { ...base.changes[1], from: 'renamed.md' }] }, 'change:path'],
    ['prune-with-summary', { ...prune, summary: 'Thin out' }, 'schema'],
    ['prune-without-parent', (({ parent: _, ...rest }) => rest)(prune), 'schema'],
    ['prune-empty', { ...prune, pruned: [] }, 'schema'],
  ].map(([name, value, reason]) => {
    const got = commitProblem(value);
    if (got !== reason) throw new Error(`invalid commit ${name}: expected ${reason}, got ${got}`);
    const bytes = canonical(value);
    return { name, kind: 'commit', reason, id: commitId(bytes), text: Buffer.from(bytes).toString('utf8'), hex: hex(bytes) };
  });
  return {
    description:
      'The example library of §12 and its history: c1 (first commit), c2 (edits, a file moved out of a ' +
      'folder that goes, a folder renamed with one file in it edited, a new Word version, a deletion), c3 ' +
      '(an import rebased onto c2), c4 (thinning) and c5 (the thinned version restored). blobs: every ' +
      'file version, stored or not. flattened_trees: each commit\'s tree as §8 flattens it, by root id. ' +
      'hex is authoritative; text is the same bytes for reading. invalid: objects that break a rule on ' +
      'their own (reason: informative).',
    library_id: LIBRARY_ID,
    blobs: [...blobs.values()],
    trees,
    commits: commits.map(({ name, id, bytes }) => ({ name, id, text: Buffer.from(bytes).toString('utf8'), hex: hex(bytes) })),
    flattened_trees: flattened,
    invalid: [...invalidTrees, ...invalidCommits],
  };
}

function commitRulesVectors(history) {
  const { commits, trees, c } = history;
  const byName = (name) => commits.find((x) => x.name === name);
  const commitCases = [];
  const commitCase = (name, commit, parentName, expected, { absent = [] } = {}) => {
    const available = new Map([...trees].filter(([id]) => !absent.includes(id)));
    const parent = parentName ? byName(parentName).commit : null;
    const got = commitProblem(commit) ?? commitContextProblem(commit, parent, available);
    if (got !== expected) throw new Error(`commit rule ${name}: expected ${expected}, got ${got}`);
    commitCases.push({
      name,
      commit,
      parent: parentName,
      ...(absent.length && { absent_trees: absent }),
      expect: expected === null ? 'valid' : expected === 'missing' ? 'missing' : 'invalid',
      ...(expected && expected !== 'missing' && { reason: expected }),
    });
  };
  const c2 = c.c2.commit;
  const changes = c2.changes;
  const move = changes.find((x) => x.op === 'move' && x.kind === 'file' && x.path.endsWith('hw2.pdf'));
  const modify = changes.find((x) => x.op === 'modify');
  const replace = (old, ...records) => changes.filter((x) => x !== old).concat(records).sort(compareChanges);
  commitCase('c2-as-written', c2, 'c1', null);
  commitCase('c4-prune', c.c4.commit, 'c3', null);
  commitCase('c5-brings-a-pruned-version-back', c.c5.commit, 'c4', null);
  commitCase('missing-record', { ...c2, changes: changes.slice(1) }, 'c1', 'coverage');
  commitCase('wrong-old-side', { ...c2, changes: replace(modify, { ...modify, old: { ...modify.old, size: modify.old.size + 1 } }) }, 'c1', 'side');
  commitCase('move-as-delete-and-add', {
    ...c2,
    changes: replace(move, { kind: 'file', old: move.old, op: 'delete', path: move.from }, { kind: 'file', new: move.new, op: 'add', path: move.path }),
  }, 'c1', null);
  commitCase('modify-as-delete-and-add', {
    ...c2,
    changes: replace(modify, { kind: 'file', old: modify.old, op: 'delete', path: modify.path }, { kind: 'file', new: modify.new, op: 'add', path: modify.path }),
  }, 'c1', null);
  const carried = `${COURSE}/讲义/L1.md`;
  const l1 = byName('c2').flat.get(carried);
  commitCase('folder-move-and-its-content-twice', {
    ...c2,
    changes: replace(null, { from: `${COURSE}/Lectures/L1.md`, kind: 'file', new: sideOf(l1), old: sideOf(l1), op: 'move', path: carried }),
  }, 'c1', 'coverage');
  const editedInMovedFolder = changes.find((x) => x.path === `${COURSE}/讲义/L2.md`);
  commitCase('folder-move-without-its-edited-file', { ...c2, changes: replace(editedInMovedFolder) }, 'c1', 'coverage');
  commitCase('changes-left-out', (({ changes: _, ...rest }) => rest)(c2), 'c1', null);
  commitCase('empty-commit', { ...c2, tree: c.c1.commit.tree }, 'c1', 'empty-commit');
  commitCase('prune-changes-tree', { ...c.c4.commit, tree: c.c1.commit.tree }, 'c3', 'prune-tree');
  const current = byName('c4').flat.get(`${COURSE}/报告.docx`).hash;
  commitCase('prune-current-version', { ...c.c4.commit, pruned: [current] }, 'c3', 'prune-current');
  const courseTree = byName('c2').order.find((t) => t.path === COURSE).id;
  commitCase('subtree-not-arrived', c2, 'c1', 'missing', { absent: [courseTree] });

  // §8 on small flattened trees.
  const file = (text, extra = {}) => ({ kind: 'file', hash: blobId(utf8(text)), size: text.length, stored: true, ...extra });
  const changeCases = [];
  const changeCase = (name, parent, tree, records, expected) => {
    const got = changesProblem(records, new Map(Object.entries(parent)), new Map(Object.entries(tree)));
    if (got !== expected) throw new Error(`changes rule ${name}: expected ${expected}, got ${got}`);
    changeCases.push({ name, parent_tree: parent, tree, changes: records, valid: expected === null, ...(expected && { reason: expected }) });
  };
  const s = (entry) => sideOf(entry);
  const [x1, y2] = [file('one'), file('two')];
  changeCase('replaced-by-a-moved-file', { x: x1, y: y2 }, { x: y2 },
    [{ kind: 'file', old: s(x1), op: 'delete', path: 'x' }, { from: 'y', kind: 'file', new: s(y2), old: s(y2), op: 'move', path: 'x' }], null);
  changeCase('replaced-by-a-moved-file-without-the-delete', { x: x1, y: y2 }, { x: y2 },
    [{ from: 'y', kind: 'file', new: s(y2), old: s(y2), op: 'move', path: 'x' }], 'coverage');
  changeCase('swap-as-moves', { a: x1, b: y2 }, { a: y2, b: x1 },
    [{ from: 'b', kind: 'file', new: s(y2), old: s(y2), op: 'move', path: 'a' }, { from: 'a', kind: 'file', new: s(x1), old: s(x1), op: 'move', path: 'b' }], null);
  changeCase('swap-as-deletes-and-adds', { a: x1, b: y2 }, { a: y2, b: x1 },
    [
      { kind: 'file', old: s(x1), op: 'delete', path: 'a' }, { kind: 'file', new: s(y2), op: 'add', path: 'a' },
      { kind: 'file', old: s(y2), op: 'delete', path: 'b' }, { kind: 'file', new: s(x1), op: 'add', path: 'b' },
    ], null);
  changeCase('file-becomes-a-folder', { n: x1 }, { n: { kind: 'dir' }, 'n/x': x1 },
    [{ kind: 'file', old: s(x1), op: 'delete', path: 'n' }, { kind: 'dir', op: 'add', path: 'n' }, { kind: 'file', new: s(x1), op: 'add', path: 'n/x' }], null);
  changeCase('stored-flag-only', { r: x1 }, { r: { ...x1, stored: false } },
    [{ kind: 'file', new: { ...s(x1), stored: false }, old: s(x1), op: 'modify', path: 'r' }], null);
  // §8 rule 6: a move whose old path holds the same entry again has no from side.
  const dir = { kind: 'dir' };
  const renamed = { 作业: dir, '作业-old': dir, '作业-old/hw1.txt': x1 };
  changeCase('folder-renamed-and-created-again-as-one-move', { 作业: dir, '作业/hw1.txt': x1 }, renamed,
    [{ from: '作业', kind: 'dir', op: 'move', path: '作业-old' }], 'coverage');
  changeCase('folder-renamed-and-created-again', { 作业: dir, '作业/hw1.txt': x1 }, renamed,
    [{ kind: 'dir', op: 'add', path: '作业-old' }, { from: '作业/hw1.txt', kind: 'file', new: s(x1), old: s(x1), op: 'move', path: '作业-old/hw1.txt' }], null);
  changeCase('moved-with-a-copy-left-behind-as-a-move', { a: x1 }, { a: x1, b: x1 },
    [{ from: 'a', kind: 'file', new: s(x1), old: s(x1), op: 'move', path: 'b' }], 'coverage');
  changeCase('moved-with-a-copy-left-behind', { a: x1 }, { a: x1, b: x1 },
    [{ kind: 'file', new: s(x1), op: 'add', path: 'b' }], null);

  // §7.4 on flattened root trees.
  const folioCases = [];
  const folioCase = (name, tree, expected) => {
    const got = rootProblem(new Map(Object.entries(tree)));
    if (got !== expected) throw new Error(`root rule ${name}: expected ${expected}, got ${got}`);
    folioCases.push({ name, tree, valid: expected === null, ...(expected && { reason: expected }) });
  };
  const meta = file('x');
  const minimal = { '.folio': { kind: 'dir' }, '.folio/library.json': meta };
  folioCase('minimal', minimal, null);
  folioCase('every-metadata-file', {
    ...minimal, '.folio/tags.json': meta, '.folio/ignore': meta, '.folio/meta': { kind: 'dir' },
    '.folio/meta/_root.json': meta, '.folio/meta/2026 秋': { kind: 'dir' }, '.folio/meta/2026 秋/_group.json': meta,
    '.folio/meta/2026 秋/__杂项.json': meta,
  }, null);
  folioCase('a-later-metadata-file', { ...minimal, '.folio/views.json': meta }, null);
  folioCase('any-file-name-in-meta', { ...minimal, '.folio/meta': { kind: 'dir' }, '.folio/meta/s': { kind: 'dir' }, '.folio/meta/s/notes.txt': meta }, null);
  folioCase('a-new-folder', { ...minimal, '.folio/cache': { kind: 'dir' } }, 'folio-path');
  folioCase('meta-in-upper-case', { ...minimal, '.folio/META': { kind: 'dir' } }, 'folio-path');
  folioCase('folder-three-levels-deep', { ...minimal, '.folio/meta': { kind: 'dir' }, '.folio/meta/s': { kind: 'dir' }, '.folio/meta/s/c': { kind: 'dir' } }, 'folio-path');
  folioCase('file-named-local', { ...minimal, '.folio/local': meta }, 'folio-private');
  folioCase('no-library-file', { '.folio': { kind: 'dir' } }, 'folio-missing');
  folioCase('folio-is-a-file', { '.folio': meta }, 'folio-missing');
  folioCase('folio-in-upper-case', { ...minimal, '.FOLIO': { kind: 'dir' } }, 'folio-name');
  folioCase('folio-with-dotless-i', { ...minimal, '.folıo': { kind: 'dir' } }, 'folio-name');
  folioCase('local-folder', { ...minimal, '.folio/local': { kind: 'dir' } }, 'folio-private');
  folioCase('store-in-upper-case', { ...minimal, '.folio/STORE': { kind: 'dir' } }, 'folio-private');
  folioCase('store-with-long-s', { ...minimal, '.folio/ſtore': { kind: 'dir' } }, 'folio-private');
  folioCase('not-stored', { ...minimal, '.folio/tags.json': { ...meta, stored: false } }, 'folio-not-stored');
  // Nested folders of 200 "a" with a file "a" in the deepest: 163 levels make a 32,764-unit path,
  // 164 levels 32,965 units. Spelled out by a pattern, not as a tree of 33 KB keys.
  const pathCases = [[163, null], [164, 'path-too-long']].map(([depth, expected]) => {
    const tree = { ...minimal };
    let path = '';
    for (let level = 0; level < depth; level++) {
      path += `${level ? '/' : ''}${'a'.repeat(200)}`;
      tree[path] = { kind: 'dir' };
    }
    tree[`${path}/a`] = meta;
    const got = rootProblem(new Map(Object.entries(tree)));
    if (got !== expected) throw new Error(`path depth ${depth}: expected ${expected}, got ${got}`);
    return {
      name: expected ? 'path-too-long' : 'path-at-the-limit',
      tree_pattern: { base: 'minimal', folder_name: { repeat: 'a', count: 200 }, depth, file_name: 'a', longest_path_utf16: utf16Length(`${path}/a`) },
      valid: expected === null,
      ...(expected && { reason: expected }),
    };
  });

  // §7.5: absent blobs and deletion, along c1–c5.
  const chain = (name) => commits.slice(0, commits.findIndex((x) => x.name === name) + 1);
  const v1 = blobId(FILES_1[`${COURSE}/报告.docx`]);
  const v2 = byName('c4').flat.get(`${COURSE}/报告.docx`).hash;
  const availability = [
    { name: 'thinned-version', head: 'c5', blob: v1, entry_commit: 'c1', expect: absentBlob(chain('c5'), 0, v1) },
    { name: 'restored-version', head: 'c5', blob: v1, entry_commit: 'c5', expect: absentBlob(chain('c5'), 4, v1) },
    { name: 'never-thinned', head: 'c5', blob: v2, entry_commit: 'c2', expect: absentBlob(chain('c5'), 1, v2) },
  ];
  const deletion = [
    { name: 'thinned-at-c4', head: 'c4', blob: v1, deletable: deletable(chain('c4'), v1) },
    { name: 'restored-at-c5', head: 'c5', blob: v1, deletable: deletable(chain('c5'), v1) },
    { name: 'current-at-c4', head: 'c4', blob: v2, deletable: deletable(chain('c4'), v2) },
  ];
  const expected = ['pruned', 'missing', 'missing', true, false, false];
  const got = [...availability.map((a) => a.expect), ...deletion.map((d) => d.deletable)];
  if (got.join() !== expected.join()) throw new Error(`availability: ${got}`);
  return {
    description:
      'Rules that need trees (§7.3–§7.5, §8). commits: a commit read with its parent (a commit of ' +
      'objects.json, by name) and the trees of objects.json; absent_trees are trees the reader does not ' +
      'have. changes: change records against small flattened trees. root: flattened root trees against ' +
      '§7.4 (other entries omitted). availability: whether an absent blob of an entry is pruned or ' +
      'missing, and whether a store may delete a blob, with the history up to head. reason: informative.',
    commits: commitCases,
    changes: changeCases,
    root: [...folioCases, ...pathCases],
    availability,
    deletion,
  };
}

function packsVectors(history) {
  const { commits, contents } = history;
  const written = new Set();
  // One pack per push, as each commit's device would write it: new blobs, trees bottom-up, the
  // commit. A blob a prune commit lists counts as absent, so c5 writes 报告.docx's first version again.
  const pruned = new Set();
  const packFor = (c, compressed) => {
    const blobs = [];
    for (const entry of c.flat.values()) {
      if (entry.kind === 'file' && entry.stored && (!written.has(entry.hash) || pruned.has(entry.hash)) && !blobs.includes(entry.hash)) {
        blobs.push(entry.hash);
      }
    }
    blobs.sort();
    for (const id of blobs) {
      written.add(id);
      pruned.delete(id);
    }
    if (c.commit.kind === 'prune') c.commit.pruned.forEach((id) => pruned.add(id));
    const frame = (wanted, key, raw) => (compressed.includes(wanted) ? frameFor(key, raw) : null);
    return encodePack([
      ...blobs.map((id) => record('blob', contents.get(id))),
      ...c.order.map(({ path, bytes }) => record('tree', bytes, frame(path, `tree ${c.name} ${path}`, bytes))),
      record('commit', c.bytes, frame('commit', `commit ${c.name}`, c.bytes)),
    ]);
  };
  const packs = [
    ['pack-1', commits[0], []],
    ['pack-2', commits[1], [COURSE, 'commit']],
    ['pack-3', commits[2], ['commit']],
    ['pack-4', commits[3], []],
    ['pack-5', commits[4], []],
  ].map(([label, c, compressed]) => {
    const bytes = packFor(c, compressed);
    const read = readPack(bytes, packName(bytes));
    if (read.status !== 'ok') throw new Error(`${label} does not verify: ${read.reason}`);
    return {
      label,
      commit: c.name,
      name: packName(bytes),
      size: bytes.length,
      objects: read.objects.map(({ type, id, offset, flags }) => ({ type, id, offset, compressed: flags === 1 })),
      hex: hex(bytes),
    };
  });

  // A small pack to break on purpose.
  const hello = utf8('hello\n');
  const helloTree = canonical({ entries: [{ hash: blobId(hello), kind: 'file', name: 'hello.txt', size: hello.length, stored: true }] });
  const blob = record('blob', hello);
  const tree = record('tree', helloTree);
  const small = encodePack([blob, tree]);
  const flip = (bytes, offset) => {
    const copy = Uint8Array.from(bytes);
    copy[offset] ^= 1;
    return copy;
  };
  const withBlob = (r) => encodePack([r, tree]);
  const asTree = (raw) => encodePack([blob, record('tree', raw)]);
  const nfdTree = canonical({ entries: [{ hash: blobId(hello), kind: 'file', name: 'résumé.txt', size: hello.length, stored: true }] });
  const variants = [
    ['valid-raw-blocks', withBlob(record('blob', hello, handZstdFrame(hello))), 'ok'],
    ['valid-frame-without-content-size', withBlob(record('blob', hello, handZstdFrame(hello, { contentSize: 0 }))), 'ok'],
    ['valid-single-segment-frame', withBlob(record('blob', hello, handZstdFrame(hello, { contentSize: 1 }))), 'ok'],
    ['valid-window-of-8-mib', withBlob(record('blob', hello, handZstdFrame(hello, { contentSize: 0, windowLog: 23 }))), 'ok'],
    ['valid-rle-block', withBlob(record('blob', utf8('aaaaaa'), handZstdFrame(utf8('aaaaaa'), { rle: true }))), 'ok'],
    ['valid-compressed-empty-object', withBlob(record('blob', new Uint8Array(), handZstdFrame(new Uint8Array()))), 'ok'],
    ['valid-frame-with-checksum', withBlob(record('blob', hello, frameFor('blob hello with checksum', hello, { checksum: true }))), 'ok'],
    ['too-short', small.subarray(0, MIN_PACK - 1), 'invalid'],
    ['bad-magic', encodePack([blob, tree], { magic: utf8('FOLIOPK2') }), 'invalid'],
    ['version-2', encodePack([blob, tree], { version: 2 }), 'newer'],
    ['version-0', encodePack([blob, tree], { version: 0 }), 'invalid'],
    ['truncated', small.subarray(0, small.length - 1), 'invalid'],
    ['hash-mismatch', flip(small, small.length - 1), 'invalid'],
    ['end-magic', encodePack([blob, tree], { endMagic: utf8('FOLIOEN!') }), 'invalid'],
    ['count-too-large', encodePack([blob, tree], { count: 1000 }), 'invalid'],
    ['index-unsorted', encodePack([blob, tree], { index: (e) => [...e].reverse() }), 'invalid'],
    ['index-missing-entry', encodePack([blob, tree], { index: (e) => e.slice(0, 1) }), 'invalid'],
    ['byte-before-index', encodePack([blob, tree], { beforeIndex: Uint8Array.of(0) }), 'invalid'],
    ['unknown-record-type', encodePack([{ ...blob, type: 4 }, tree]), 'invalid'],
    ['reserved-flag', encodePack([{ ...blob, flags: 2 }, tree]), 'invalid'],
    ['raw-length-mismatch', withBlob({ ...blob, rawLength: 7 }), 'invalid'],
    ['object-id-mismatch', withBlob({ ...blob, payload: utf8('hellO\n') }), 'invalid'],
    ['duplicate-object', encodePack([blob, blob, tree]), 'invalid'],
    ['zstd-content-size-mismatch', withBlob({ ...record('blob', hello, handZstdFrame(hello)), rawLength: 5 }), 'invalid'],
    ['zstd-decoded-size-mismatch', withBlob({ ...record('blob', hello, handZstdFrame(hello, { contentSize: 0 })), rawLength: 5 }), 'invalid'],
    ['zstd-trailing-bytes', withBlob(record('blob', hello, concat(handZstdFrame(hello), Uint8Array.of(0)))), 'invalid'],
    ['zstd-dictionary', withBlob(record('blob', hello, handZstdFrame(hello, { dictionary: 7 }))), 'invalid'],
    ['zstd-window-too-large', withBlob(record('blob', hello, handZstdFrame(hello, { contentSize: 0, windowLog: 24 }))), 'invalid'],
    ['zstd-reserved-bit', withBlob(record('blob', hello, handZstdFrame(hello, { reserved: true }))), 'invalid'],
    ['zstd-truncated-header', withBlob(record('blob', hello, handZstdFrame(hello).subarray(0, 9))), 'invalid'],
    ['zstd-corrupt-block', withBlob(record('blob', hello, (() => {
      const frame = handZstdFrame(hello);
      frame[14] |= 0b100; // the block becomes "compressed", and its bytes are not
      return frame;
    })())), 'invalid'],
    ['tree-declared-too-large', encodePack([blob, { ...record('tree', helloTree, handZstdFrame(helloTree)), rawLength: MAX_OBJECT + 1 }]), 'invalid'],
    ['tree-nested-too-deeply', asTree(utf8('['.repeat(20) + ']'.repeat(20))), 'invalid'],
    ['noncanonical-tree', asTree(utf8(Buffer.from(helloTree).toString().replace(':', ': '))), 'invalid'],
    ['tree-unknown-field', asTree(canonical({ entries: [{ ...JSON.parse(Buffer.from(helloTree).toString()).entries[0], mode: 420 }] })), 'invalid'],
    ['tree-name-not-nfc', asTree(nfdTree), 'invalid'],
  ].map(([name, bytes, status]) => {
    const read = readPack(bytes, packName(bytes));
    if (read.status !== status) throw new Error(`pack ${name}: expected ${status}, got ${read.status} (${read.reason})`);
    return { name, file_name: packName(bytes), expect: status, ...(read.reason && { reason: read.reason }), hex: hex(bytes) };
  });
  const misnamed = `${'0'.repeat(64)}.pack`;
  if (readPack(small, misnamed).status !== 'invalid') throw new Error('a misnamed pack verified');
  variants.push({ name: 'name-mismatch', file_name: misnamed, expect: 'invalid', reason: readPack(small, misnamed).reason, hex: hex(small) });
  return {
    description:
      'Packs to read. Each hex is a whole file and file_name its name in packs/. pack-1 to pack-5 hold ' +
      'what c1 to c5 add, one pack per push as §9.5 suggests, with zstd frames in pack-2 and pack-3; ' +
      'pack-5 carries a blob that c4 pruned again. A writer need not reproduce these bytes ' +
      '(compressed payloads and record order are free, §9.5); a reader must read them. variants: ' +
      'expect ok, newer or invalid; reason is informative.',
    packs,
    variants,
  };
}

function mirrorWrites(before, after) {
  const writes = [];
  for (const [path, entry] of after) {
    if (before.has(path) && sameEntry(before.get(path), entry)) continue;
    if (entry.kind === 'dir' && before.get(path)?.kind === 'dir') continue;
    writes.push(entry.kind === 'file' ? { hash: entry.hash, kind: 'file', op: 'write', path } : { kind: 'dir', op: 'write', path });
  }
  for (const [path, entry] of before) {
    if (!after.has(path) || after.get(path).kind !== entry.kind) writes.push({ kind: entry.kind, op: 'delete', path });
  }
  return writes.sort(compareWrites);
}

function recordsVectors(history, packs) {
  const { commits } = history;
  const [c1, c2, c3, c4, c5] = commits;
  const store = '.folio/store';
  const ref = (label) => {
    const pack = packs.packs.find((p) => p.label === label);
    return { name: pack.name, size: pack.size };
  };
  const head = (device, seq, intent, lamport, c, label, time) => ({
    value: { device, format_version: 1, head: c.id, intent, lamport, library_id: LIBRARY_ID, packs: [ref(label)], seq, time },
    path: `${store}/heads/${device.id}/${seq}.json`,
  });
  const intent = (device, seq, base, c, time) => ({
    value: {
      ...(base && { base: base.id }),
      device, format_version: 1, head: c.id, library_id: LIBRARY_ID, seq, time,
      writes: mirrorWrites(base ? base.flat : new Map(), c.flat),
    },
    path: `${store}/intents/${device.id}/${seq}.json`,
  });
  const heads = [
    head(DEVICE_A, 1, 1, 1, c1, 'pack-1', '2026-10-03T21:15:00Z'),
    head(DEVICE_A, 2, 2, 2, c2, 'pack-2', '2026-10-04T08:00:00Z'),
    head(DEVICE_B, 1, 1, 3, c3, 'pack-3', '2026-10-05T14:05:00Z'),
    head(DEVICE_A, 3, 3, 4, c4, 'pack-4', '2026-12-10T03:05:00Z'),
    head(DEVICE_A, 4, 4, 5, c5, 'pack-5', '2026-12-11T10:05:00Z'),
  ];
  const intents = [
    intent(DEVICE_A, 1, null, c1, '2026-10-03T21:14:00Z'),
    intent(DEVICE_A, 2, c1, c2, '2026-10-04T07:59:00Z'),
    intent(DEVICE_B, 1, c2, c3, '2026-10-05T14:04:00Z'),
  ];
  const format = { value: { format_version: 1, library_id: LIBRARY_ID }, path: `${store}/FORMAT.json` };
  const cases = [];
  const addCase = (kind, name, bytes, path, status) => {
    const read = readRecord(kind, bytes, path);
    if (read.status !== status) throw new Error(`record ${name}: expected ${status}, got ${read.status} (${read.reason})`);
    cases.push({ kind, name, path, expect: status, ...(read.reason && { reason: read.reason }), text: Buffer.from(bytes).toString('utf8'), hex: hex(bytes) });
  };
  const sample = heads[1];
  const sampleIntent = intents[1];
  addCase('format', 'FORMAT.json', canonical(format.value), format.path, 'ok');
  addCase('format', 'newer', canonical({ ...format.value, format_version: 2 }), format.path, 'newer');
  addCase('format', 'newer-and-not-version-1-json', utf8('{\n  "format_version": 2,\n  "x": null\n}\n'), format.path, 'newer');
  addCase('format', 'no-version', canonical({ library_id: LIBRARY_ID }), format.path, 'invalid');
  addCase('format', 'unknown-field', canonical({ ...format.value, created: '2026-10-03T21:14:00Z' }), format.path, 'invalid');
  addCase('format', 'upper-case-library-id', canonical({ ...format.value, library_id: LIBRARY_ID.toUpperCase() }), format.path, 'invalid');
  addCase('format', 'pretty-printed', utf8(JSON.stringify(format.value, null, 2)), format.path, 'invalid');
  addCase('format', 'misplaced', canonical(format.value), `${store}/FORMAT 2.json`, 'invalid');
  for (const h of heads) addCase('head', `heads ${h.value.device.name} ${h.value.seq}`, canonical(h.value), h.path, 'ok');
  addCase('head', 'newer', canonical({ ...sample.value, format_version: 2, extra: true }), sample.path, 'newer');
  addCase('head', 'seq-0', canonical({ ...sample.value, seq: 0 }), sample.path.replace('/2.json', '/0.json'), 'invalid');
  addCase('head', 'intent-after-seq', canonical({ ...sample.value, intent: 3 }), sample.path, 'invalid');
  addCase('head', 'upper-case-pack-name', canonical({ ...sample.value, packs: [{ ...ref('pack-2'), name: ref('pack-2').name.replace(/[a-f]/g, (ch) => ch.toUpperCase()) }] }), sample.path, 'invalid');
  addCase('head', 'pack-smaller-than-any-pack', canonical({ ...sample.value, packs: [{ ...ref('pack-2'), size: MIN_PACK - 1 }] }), sample.path, 'invalid');
  addCase('head', 'unsorted-packs', canonical({ ...sample.value, packs: [ref('pack-1'), ref('pack-2')].sort((a, b) => -compareUtf8(a.name, b.name)) }), sample.path, 'invalid');
  addCase('head', 'in-another-devices-folder', canonical(sample.value), sample.path.replace(DEVICE_A.id, DEVICE_B.id), 'invalid');
  addCase('head', 'file-name-and-seq-differ', canonical(sample.value), sample.path.replace('/2.json', '/3.json'), 'invalid');
  addCase('head', 'leading-zero-in-file-name', canonical(sample.value), sample.path.replace('/2.json', '/02.json'), 'invalid');
  for (const i of intents) addCase('intent', `intents ${i.value.device.name} ${i.value.seq}`, canonical(i.value), i.path, 'ok');
  const withWrites = (writes) => canonical({ ...sampleIntent.value, writes });
  addCase('intent', 'write-without-hash', withWrites([{ kind: 'file', op: 'write', path: 'a.md' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'delete-with-hash', withWrites([{ hash: c1.id, kind: 'file', op: 'delete', path: 'a.md' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'unsorted-writes', withWrites([...sampleIntent.value.writes].reverse()), sampleIntent.path, 'invalid');
  addCase('intent', 'writes-into-the-store', withWrites([{ hash: c1.id, kind: 'file', op: 'write', path: '.folio/store/heads/x/9.json' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'writes-into-local', withWrites([{ hash: c1.id, kind: 'file', op: 'write', path: '.folio/local/HEAD' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'deletes-folio', withWrites([{ kind: 'dir', op: 'delete', path: '.folio' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'folio-in-upper-case', withWrites([{ hash: c1.id, kind: 'file', op: 'write', path: '.FOLIO/library.json' }]), sampleIntent.path, 'invalid');
  addCase('intent', 'writes-metadata', withWrites([{ hash: c1.id, kind: 'file', op: 'write', path: '.folio/library.json' }]), sampleIntent.path, 'ok');
  addCase('intent', 'path-not-nfc', withWrites([{ hash: c1.id, kind: 'file', op: 'write', path: 'résumé.docx' }]), sampleIntent.path, 'invalid');
  return {
    description:
      'Records of the remote store (§10; provisional until v0.3, when this file freezes like the others). ' +
      'path is where the record lies in the remote; heads and intents tell the story of packs.json: ' +
      'device A pushes c1 and c2, device B its rebased import c3, device A the prune commit c4 and c5. ' +
      'reason: informative.',
    records: cases,
  };
}

function build() {
  const history = buildHistory();
  const packs = packsVectors(history);
  return {
    'hashes.json': hashesVectors(),
    'canonical-json.json': canonicalJsonVectors(),
    'values.json': valuesVectors(),
    'objects.json': objectsVectors(history),
    'commit-rules.json': commitRulesVectors(history),
    'packs.json': packs,
    'records.json': recordsVectors(history, packs),
  };
}

function main() {
  // The first BLAKE3 test vector (empty input).
  if (hex(blake3(new Uint8Array())) !== 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262') {
    throw new Error('BLAKE3 is broken');
  }
  const files = build();
  if (missingFrames.length) {
    console.error(`Freeze these zstd frames in FRAMES, then run again:\n${missingFrames.join('\n')}`);
    process.exit(1);
  }
  const check = process.argv.includes('--check');
  let stale = 0;
  if (!check) mkdirSync(OUT, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const text = `${JSON.stringify(content, null, 2)}\n`;
    const path = join(OUT, name);
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        console.error(`stale: v1/${name}`);
        stale++;
      }
    } else {
      writeFileSync(path, text);
    }
  }
  if (stale) process.exit(1);
  console.log(check ? 'v1/ matches the generator' : `wrote ${Object.keys(files).length} files to v1/`);
}

main();
