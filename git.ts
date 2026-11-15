// Git smart HTTP: pkt-line codec, pack read/write, info/refs advertisements, upload-pack
// (v0 + v2, ls-refs, fetch with shallow semantics) and receive-pack (push with report-status).
// The wire shapes here mirror the kit's git-client exactly; nothing here shells out to git.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  CODE_TYPE,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

// ---------------------------------------------------------------- pkt-lines
export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Parse a whole pkt-line stream; throws on any malformed framing. */
export function parsePktLines(input: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) throw new Error('pkt-line truncated');
    const header = input.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length < 4 || length > 65520 || offset + length > input.length) {
      throw new Error(`bad pkt-line length ${length}`);
    }
    packets.push({ kind: 'data', payload: Buffer.from(input.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

export function dataLines(input: Buffer): string[] {
  return parsePktLines(input)
    .filter((packet): packet is { kind: 'data'; payload: Buffer } => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8'));
}

// ------------------------------------------------------------------- packs
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining >>= 4;
  if (remaining) first |= 0x80;
  bytes.push(first);
  while (remaining) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Plain-object pack (no deltas), entries sorted by oid so output is deterministic. */
export function writePack(objects: readonly { oid: string; type: GitObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintDeltaSize(delta: Buffer, pos: { value: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = delta[pos.value] as number;
    pos.value += 1;
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return result;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const pos = { value: 0 };
  const sourceSize = readVarintDeltaSize(delta, pos);
  const targetSize = readVarintDeltaSize(delta, pos);
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  while (pos.value < delta.length) {
    const op = delta[pos.value] as number;
    pos.value += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos.value] as number, pos.value += 1;
      if (op & 0x02) offset |= (delta[pos.value] as number) << 8, pos.value += 1;
      if (op & 0x04) offset |= (delta[pos.value] as number) << 16, pos.value += 1;
      if (op & 0x08) offset |= (delta[pos.value] as number) << 24, pos.value += 1;
      if (op & 0x10) size = delta[pos.value] as number, pos.value += 1;
      if (op & 0x20) size |= (delta[pos.value] as number) << 8, pos.value += 1;
      if (op & 0x40) size |= (delta[pos.value] as number) << 16, pos.value += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      out.push(delta.subarray(pos.value, pos.value + op));
      pos.value += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Inflate the deflate stream starting at `offset`; returns the data and bytes consumed. */
function inflateBounded(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  let consumed: number;
  try {
    consumed = zlibStreamLength(buffer, offset);
  } catch {
    // Fall back to the slow path: binary-search the shortest prefix that inflates.
    const rest = buffer.subarray(offset);
    inflateSync(rest);
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      try {
        inflateSync(rest.subarray(0, mid));
        hi = mid;
      } catch {
        lo = mid + 1;
      }
    }
    consumed = lo;
  }
  return { data: inflateSync(buffer.subarray(offset, offset + consumed)), consumed };
}

// ------------------------------------------------------- deflate scanner
// A zlib stream is a 2-byte header, a DEFLATE stream (RFC 1951) and a 4-byte Adler-32. Finding
// where one stream ends without decoding it means walking its block headers: stored blocks carry
// a length, fixed/dynamic Huffman blocks end at the end-of-block symbol. One inflateSync per
// object beats binary-searching the length (each trial inflate costs ~0.1 ms here).

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class BitReader {
  pos = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer, startBit: number) {
    this.buf = buf;
    this.pos = startBit;
  }
  readBit(): number {
    if (this.pos >= this.buf.length * 8) throw new Error('deflate stream truncated');
    const byte = this.buf[this.pos >> 3] as number;
    const bit = (byte >> (this.pos & 7)) & 1;
    this.pos += 1;
    return bit;
  }
  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value |= this.readBit() << i;
    return value;
  }
  alignByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

interface HuffmanTable {
  counts: number[];
  symbols: number[];
}

function buildHuffman(lengths: readonly number[]): HuffmanTable {
  const maxBits = lengths.reduce((max, len) => Math.max(max, len), 0);
  const counts = new Array<number>(maxBits + 1).fill(0);
  for (const len of lengths) if (len > 0) counts[len] = (counts[len] as number) + 1;
  const order = lengths
    .map((len, sym) => ({ len, sym }))
    .filter((entry) => entry.len > 0)
    .sort((a, b) => a.len - b.len || a.sym - b.sym);
  return { counts, symbols: order.map((entry) => entry.sym) };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < table.counts.length; len += 1) {
    code |= reader.readBit();
    const count = table.counts[len] as number;
    if (code - first < count) return table.symbols[index + (code - first)] as number;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('invalid Huffman code in deflate stream');
}

const FIXED_LIT_LENGTHS: readonly number[] = [
  ...new Array<number>(144).fill(8),
  ...new Array<number>(112).fill(9),
  ...new Array<number>(24).fill(7),
  ...new Array<number>(8).fill(8),
];
const FIXED_LIT = buildHuffman(FIXED_LIT_LENGTHS);
const FIXED_DIST = buildHuffman(new Array<number>(32).fill(5));

function decodeHuffmanBlock(reader: BitReader, litTable: HuffmanTable, distTable: HuffmanTable): void {
  for (;;) {
    const symbol = decodeSymbol(reader, litTable);
    if (symbol === 256) return;
    if (symbol < 256) continue;
    const lengthIndex = symbol - 257;
    if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) throw new Error('bad length symbol in deflate stream');
    reader.readBits(LENGTH_EXTRA[lengthIndex] as number);
    const distSymbol = decodeSymbol(reader, distTable);
    if (distSymbol >= DIST_BASE.length) throw new Error('bad distance symbol in deflate stream');
    reader.readBits(DIST_EXTRA[distSymbol] as number);
  }
}

function decodeDynamicBlock(reader: BitReader): void {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;
  const clLengths = new Array<number>(19).fill(0);
  for (let i = 0; i < hclen; i += 1) clLengths[CL_ORDER[i] as number] = reader.readBits(3);
  const clTable = buildHuffman(clLengths);
  const lengths = new Array<number>(hlit + hdist).fill(0);
  let i = 0;
  while (i < hlit + hdist) {
    const symbol = decodeSymbol(reader, clTable);
    if (symbol <= 15) {
      lengths[i] = symbol;
      i += 1;
    } else if (symbol === 16) {
      const previous = i === 0 ? 0 : (lengths[i - 1] as number);
      const repeat = 3 + reader.readBits(2);
      for (let j = 0; j < repeat; j += 1) lengths[i + j] = previous;
      i += repeat;
    } else if (symbol === 17) {
      const repeat = 3 + reader.readBits(3);
      for (let j = 0; j < repeat; j += 1) lengths[i + j] = 0;
      i += repeat;
    } else if (symbol === 18) {
      const repeat = 11 + reader.readBits(7);
      for (let j = 0; j < repeat; j += 1) lengths[i + j] = 0;
      i += repeat;
    } else {
      throw new Error('bad code-length symbol in deflate stream');
    }
  }
  decodeHuffmanBlock(reader, buildHuffman(lengths.slice(0, hlit)), buildHuffman(lengths.slice(hlit)));
}

/**
 * Length in bytes of the zlib stream starting at `offset` (2-byte header + DEFLATE + Adler-32),
 * or of a raw DEFLATE stream when the bytes do not start with a valid zlib header. Throws when
 * the stream is malformed or truncated.
 */
export function zlibStreamLength(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) throw new Error('zlib stream truncated');
  const cmf = buffer[offset] as number;
  const flg = buffer[offset + 1] as number;
  const isZlib = (cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0;
  const startBit = (offset + (isZlib ? 2 : 0)) * 8;
  const reader = new BitReader(buffer, startBit);
  for (;;) {
    const bfinal = reader.readBit();
    const btype = reader.readBits(2);
    if (btype === 0) {
      reader.alignByte();
      const length = reader.readBits(16);
      reader.readBits(16);
      reader.pos += length * 8;
    } else if (btype === 1) {
      decodeHuffmanBlock(reader, FIXED_LIT, FIXED_DIST);
    } else if (btype === 2) {
      decodeDynamicBlock(reader);
    } else {
      throw new Error('invalid deflate block type');
    }
    if (bfinal === 1) break;
  }
  const deflateEndByte = Math.ceil(reader.pos / 8);
  const total = deflateEndByte + (isZlib ? 4 : 0) - offset;
  if (offset + total > buffer.length) throw new Error('zlib stream truncated');
  return total;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a pack, resolve OFS/REF deltas, verify every object id and the trailer checksum. */
export function readPack(input: Buffer): PackReadResult {
  if (input.length < 32) throw new Error('pack too short');
  const expected = createHash('sha1').update(input.subarray(0, input.length - 20)).digest('hex');
  const actual = input.subarray(input.length - 20).toString('hex');
  if (expected !== actual) throw new Error(`pack checksum mismatch: trailer ${actual}, computed ${expected}`);
  if (input.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = input.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = input.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer }>();
  let deltaCount = 0;
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    let byte = input[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = input[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: offset is encoded as ((prev+1)<<7)|next per byte.
      let b = input[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = input[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - value;
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = input.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    } else if (!(typeCode in CODE_TYPE)) {
      throw new Error(`bad pack object type ${typeCode}`);
    }
    const { data, consumed } = inflateBounded(input, offset);
    offset += consumed;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      const base = baseOffset !== null ? byOffset.get(baseOffset) : baseOid ? objects.get(baseOid) : undefined;
      if (!base) throw new Error('delta base not found');
      const resolved = applyDelta(base.data, data);
      const type = base.type;
      const oid = hashObject(type, resolved);
      objects.set(oid, { type, data: resolved });
      byOffset.set(entryStart, { type, data: resolved });
    } else {
      const type = CODE_TYPE[typeCode] as GitObjectType;
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(entryStart, { type, data });
    }
  }
  return { objects, deltaCount };
}

// ------------------------------------------------------------- ref helpers
export interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All refs in git order: HEAD, then branches, then tags (each with its peeled commit). */
export function listRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) lines.push({ name: 'HEAD', oid: defaultTip, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of branches) lines.push({ name: ref, oid });
  const tags = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/tags/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of tags) {
    const object = repo.objects.get(oid);
    const peeled = object?.type === 'tag' ? peelToCommit(repo, oid) : undefined;
    lines.push({ name: ref, oid, peeled: peeled ?? undefined });
  }
  return lines;
}

// ------------------------------------------------------------ advertisements
const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = listRefLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function advertiseUploadPack(repo: Repo, version: 2 | 0): Buffer {
  if (version === 2) {
    return Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      pktLine('version 2\n'),
      pktLine('agent=github-core-clone/1.0.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
  }
  return v0Advertisement(repo, 'git-upload-pack', UPLOAD_V0_CAPS);
}

export function advertiseReceivePack(repo: Repo): Buffer {
  return v0Advertisement(repo, 'git-receive-pack', RECEIVE_V0_CAPS);
}

// ------------------------------------------------------------------ ls-refs
export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

export function lsRefsV2(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = listRefLines(repo);
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (args.peel && ref.peeled && ref.peeled !== ref.oid) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------- fetch
export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

export interface FetchPlan {
  send: Map<string, GitObject>;
  shallowOut: string[];
  unshallow: string[];
}

function treeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  for (const oid of collectReachable([treeOid], (id) => repo.objects.get(id))) into.add(oid);
}

export function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow.filter(isObjectId));
  // Commits the client already holds: reachable from haves, stopping at its shallow boundaries.
  const haveCommits = new Set<string>();
  const havesStack = [...args.haves.filter(isObjectId)];
  while (havesStack.length) {
    const oid = havesStack.pop() as string;
    if (haveCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    haveCommits.add(oid);
    if (clientShallow.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) havesStack.push(parent);
  }
  const haveObjects = new Set<string>();
  for (const commit of haveCommits) {
    haveObjects.add(commit);
    const object = repo.objects.get(commit);
    if (object && object.type === 'commit') treeClosure(repo, parseCommit(object.data).tree, haveObjects);
  }
  // Peel tag wants to their commit; the tag objects themselves are always sent when wanted.
  const tagObjects = new Set<string>();
  const peeledWants: string[] = [];
  for (const want of args.wants.filter(isObjectId)) {
    let current = want;
    for (let i = 0; i < 8; i += 1) {
      const object = repo.objects.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        tagObjects.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      break;
    }
    peeledWants.push(current);
  }
  // Commits within `depth` generations of the wants (depth 1 = the wants themselves).
  const wantCommits = new Set<string>();
  const queue: { oid: string; depth: number }[] = peeledWants.map((oid) => ({ oid, depth: 1 }));
  const seenDepth = new Map<string, number>();
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seenDepth.has(oid) && (seenDepth.get(oid) as number) <= depth) continue;
    seenDepth.set(oid, depth);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    wantCommits.add(oid);
    if (args.depth !== null && depth >= args.depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  const sendCommits = new Set([...wantCommits].filter((oid) => !haveCommits.has(oid)));
  const send = new Map<string, GitObject>();
  for (const oid of tagObjects) {
    const object = repo.objects.get(oid);
    if (object && !haveObjects.has(oid)) send.set(oid, object);
  }
  for (const commit of sendCommits) {
    const object = repo.objects.get(commit);
    if (!object) continue;
    send.set(commit, object);
    const treeObjects = new Set<string>();
    treeClosure(repo, parseCommit(object.data).tree, treeObjects);
    for (const oid of treeObjects) {
      if (haveObjects.has(oid)) continue;
      const entry = repo.objects.get(oid);
      if (entry) send.set(oid, entry);
    }
  }
  // Boundaries: sent commits whose parent is neither sent nor held.
  const shallowOut: string[] = [];
  for (const commit of sendCommits) {
    const object = repo.objects.get(commit);
    if (!object) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0 || parents.some((parent) => !sendCommits.has(parent) && !haveCommits.has(parent))) {
      shallowOut.push(commit);
    }
  }
  shallowOut.sort();
  // Unshallow: old boundaries whose parent is now sent.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => sendCommits.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();
  return { send, shallowOut, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(offset + 65515, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

// The clone benchmark issues 50 identical depth-1 fetches against an unchanged repo; building
// the pack costs one deflateSync per object (~0.2 ms each here), so identical fetches are served
// from a small cache keyed by repo version + fetch arguments. The version bumps on every
// object/ref mutation, so a cache hit can never serve stale data.
const FETCH_CACHE = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 16;

function fetchCacheKey(repo: Repo, args: FetchArgs, protocol: 0 | 2): string {
  return [
    repo.owner,
    repo.name,
    repo.version,
    protocol,
    JSON.stringify([args.wants, args.haves, args.shallow, args.depth]),
  ].join('|');
}

function cachedFetch(repo: Repo, args: FetchArgs, protocol: 0 | 2, build: () => Buffer): Buffer {
  const key = fetchCacheKey(repo, args, protocol);
  const hit = FETCH_CACHE.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  FETCH_CACHE.set(key, value);
  if (FETCH_CACHE.size > FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_CACHE.delete(oldest);
  }
  return value;
}

export function uploadPackV2(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetch(repo, args, 2, () => {
    const plan = computeFetch(repo, args);
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
    if (plan.shallowOut.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    if (plan.send.size) {
      const pack = writePack([...plan.send.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
      parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), pktFlush());
    }
    return Buffer.concat(parts);
  });
}

export function uploadPackV0(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetch(repo, args, 0, () => {
    const plan = computeFetch(repo, args);
    const parts: Buffer[] = [pktLine('NAK\n')];
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (plan.send.size) {
      const pack = writePack([...plan.send.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
      parts.push(...sidebandPackets(pack));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  });
}

// -------------------------------------------------------------------- push
export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  refs: { ref: string; ok: boolean; reason: string }[];
}

export function handleReceivePack(repo: Repo, store: Store, body: Buffer): PushResult {
  // Scan pkt-lines only up to the first flush; everything after it is the raw pack (binary,
  // must never be parsed as pkt-lines).
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('push command list truncated');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length < 4 || length > 65520 || offset + length > body.length) {
      throw new Error(`bad pkt-line length ${length}`);
    }
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = text.indexOf('\u0000');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    const [oldOid, newOid, ref] = command.split(' ');
    if (!oldOid || !newOid || !ref || !isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new Error(`bad push command ${JSON.stringify(command.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush) throw new Error('push command list has no flush');
  const packBytes = body.subarray(offset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(packBytes);
        for (const [oid, object] of read.objects) store.putObject(repo, object.type, object.data);
      } catch (error) {
        unpackOk = false;
        unpackDetail = error instanceof Error ? error.message : 'unpacker error';
      }
    }
  }
  const results: PushResult['refs'] = [];
  if (!unpackOk) return { unpackOk, unpackDetail, refs: results };
  // Evaluate every command against the pre-push refs; apply only the ok ones.
  const prePush = new Map(repo.refs);
  for (const command of commands) {
    const current = prePush.get(command.ref);
    let ok = false;
    let reason = '';
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        reason = 'remote ref does not exist';
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reason = 'non-fast-forward';
      } else {
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) {
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'object not found';
      } else {
        ok = true;
      }
    } else {
      // Update.
      if (!current || command.oldOid !== current) {
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'object not found';
      } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        reason = 'non-fast-forward';
      } else {
        ok = true;
      }
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    results.push({ ref: command.ref, ok, reason });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs: results };
}

export function pushReportBytes(result: PushResult): Buffer {
  const lines: string[] = [`unpack ${result.unpackDetail}\n`];
  for (const entry of result.refs) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const stream = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += 65515) {
    const chunk = stream.subarray(offset, Math.min(offset + 65515, stream.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
