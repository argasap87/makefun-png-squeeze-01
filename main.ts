// Squeeze screenshots into the smallest PNG (make.fun png-squeeze-01-run-20261127).
//
// Pipeline: decode the stored RGBA PNG -> analyse the pixels -> screen the exact
// colour-type forms (palette by count / by luminance, grey, grey+alpha, RGB, RGBA,
// with a tRNS key when one fully-transparent value exists) and the per-row filter
// choices (fixed 0-4, minsum, pairs, brute force) with zlib -> write the winner
// with the best deflate we have (zlib level 9 in v1, optimal-parse DP in v2).
//
// Lossless: every pixel's RGBA decodes back exactly, transparent pixels included.
// Deterministic: no clock, no randomness, no environment-dependent choices.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;

// ---------------------------------------------------------------- CRC-32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- PNG write
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- PNG decode
// Input is a stored PNG (colour type 6, unfiltered rows), but unfilter generically.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      width = view.getUint32(at - 12 - len + 8);
      height = view.getUint32(at - 12 - len + 12);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (colourType !== 6) throw new Error(`input colour type ${colourType}, expected 6`);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1) + 1;
    const ft = raw[y * (stride + 1)];
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) rgba.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= 4 ? rgba[o + i - 4] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (((i >= 4 ? rgba[o + i - 4] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[o + i - 4] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= 4 ? rgba[p + i - 4] : 0;
        rgba[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error(`bad filter ${ft}`);
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- analyse
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((w) => {
        const r = (w >>> 24) & 0xff;
        const g = (w >>> 16) & 0xff;
        const b = (w >>> 8) & 0xff;
        const a = w & 0xff;
        return { rgba: [r, g, b, a], word: w, count: counts.get(w) };
      });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of alpha.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------- palette
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const w = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(w);
  }
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- forms
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum'],
  });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------- filters
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filtered data for one form + choice. `raw` is a reusable buffer of the right size.
function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- screen
// Screen every (form, filter) with zlib level 1 (fast ranking; the top two
// are re-weighed at level 9), then re-weigh the best two at level 9.
// winning form also has a brute-force filter that did not win, that brute
// candidate { data, zlib } (the DP often prefers it over the zlib winner).
function screen(rgba, width, height) {
  const ranked = [];
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    const buf = new Uint8Array(size);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, buf);
      const z = deflateSync(data, { level: 1, memLevel: 8 });
      ranked.push({ form, choice, bytes: z.length + chunks, data: data.slice() });
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  let best = null;
  for (const cand of ranked.slice(0, 2)) {
    const z = deflateSync(cand.data, { level: 9, memLevel: 9 });
    const bytes = z.length + chunkBytes(cand.form);
    if (best === null || bytes < best.bytes) best = { form: cand.form, choice: cand.choice, data: cand.data, zlib: z, bytes };
  }
  let brute = null;
  if (best.form.filters.includes('brute') && best.choice !== 'brute') {
    const cand = ranked.find((c) => c.form === best.form && c.choice === 'brute');
    if (cand !== undefined) brute = { data: cand.data, zlib: deflateSync(cand.data, { level: 9, memLevel: 9 }) };
  }
  return { winner: best, brute };
}

// ---------------------------------------------------------------- deflate
// Optimal-parse deflate in the manner of zopfli, written for this entry:
// hash-chain lazy match finding, DP over (length, distance) candidates with a
// bit-cost model, package-style length-limited Huffman, block splitting with
// per-block dynamic Huffman. Two known traps handled: length 258 maps to
// symbol 285 (not 284), and the length-symbol table is a Uint16Array (a
// Uint8Array would wrap 257 to 1).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// length -> literal/length symbol (257..285). Uint16Array: symbols exceed 255.
const LEN_SYM = (() => {
  const t = new Uint16Array(259);
  for (let s = 0; s < 29; s++) {
    const next = s + 1 < 29 ? LEN_BASE[s + 1] : 259;
    for (let l = LEN_BASE[s]; l < next; l++) t[l] = 257 + s;
  }
  return t;
})();
// distance -> distance symbol (0..29).
const DIST_SYM = (() => {
  const t = new Uint8Array(32769);
  for (let s = 0; s < 30; s++) {
    const next = s + 1 < 30 ? DIST_BASE[s + 1] : 32769;
    for (let d = DIST_BASE[s]; d < next; d++) t[d] = s;
  }
  return t;
})();

// Length-limited Huffman code lengths from symbol frequencies. Heap-built,
// halving frequencies and rebuilding while any length exceeds maxBits.
function buildLengths(freqs, maxBits) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freqs[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  let f = freqs;
  for (let attempt = 0; attempt < 40; attempt++) {
    // Binary heap of [freq, node]; node is a symbol or an array of two nodes.
    const heap = [];
    const push = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const tmp = heap[p];
        heap[p] = heap[i];
        heap[i] = tmp;
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const tmp = heap[m];
          heap[m] = heap[i];
          heap[i] = tmp;
          i = m;
        }
      }
      return top;
    };
    for (const s of syms) push([f[s], s]);
    while (heap.length > 1) {
      const a = pop();
      const b = pop();
      push([a[0] + b[0], [a[1], b[1]]]);
    }
    lengths.fill(0);
    let maxLen = 0;
    const walk = (node, depth) => {
      if (typeof node === 'number') {
        lengths[node] = depth;
        if (depth > maxLen) maxLen = depth;
      } else {
        walk(node[0], depth + 1);
        walk(node[1], depth + 1);
      }
    };
    walk(heap[0][1], 0);
    if (maxLen <= maxBits) return lengths;
    const g = new Uint32Array(n);
    for (let s = 0; s < n; s++) g[s] = f[s] > 0 ? Math.max(1, f[s] >> 1) : 0;
    f = g;
  }
  // Fallback: fixed lengths (valid, if not optimal).
  for (const s of syms) lengths[s] = 8;
  return lengths;
}

// Canonical codes from lengths; codes are bit-reversed for LSB-first output.
function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Uint32Array(16);
  for (let s = 0; s < n; s++) blCount[lengths[s]]++;
  blCount[0] = 0;
  const nextCode = new Uint32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (len === 0) continue;
    let c = nextCode[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) {
      rev = (rev << 1) | (c & 1);
      c >>>= 1;
    }
    codes[s] = rev;
  }
  return codes;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Bit writer, LSB-first, with growth.
class BitWriter {
  constructor(cap) {
    this.buf = new Uint8Array(cap);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  grow() {
    const nb = new Uint8Array(this.buf.length * 2);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  write(value, count) {
    this.bitBuf |= (value << this.bitCnt) >>> 0;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  finish() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

// Hash-chain match finder over one block [lo, hi) of data.
class Matcher {
  constructor(data, lo, hi) {
    this.d = data;
    this.lo = lo;
    this.hi = hi;
    this.head = new Int32Array(65536).fill(-1);
    this.prev = new Int32Array(hi - lo);
  }
  // Finds Pareto-optimal (length, distance) candidates at position pos.
  // Writes into candLen/candDist, returns the count. Inserts pos into chains.
  find(pos, maxDepth, candLen, candDist) {
    const d = this.d;
    const n = this.hi;
    const maxLen = Math.min(258, n - pos);
    let count = 0;
    if (maxLen >= 3) {
      const h = (Math.imul(((d[pos] << 16) ^ (d[pos + 1] << 8) ^ d[pos + 2]) >>> 0, 2654435761) >>> 16) & 0xffff;
      let p = this.head[h];
      let best = 2;
      let depth = 0;
      while (p >= 0 && depth < maxDepth) {
        const dist = pos - p;
        if (dist > 32768) break;
        // Quick reject: a candidate can only beat `best` if byte `best` matches;
        // otherwise its common prefix is at most `best` long. This turns most
        // chain steps into a single byte compare instead of a full scan.
        if (d[p + best] === d[pos + best]) {
          let len = 0;
          while (len < maxLen && d[p + len] === d[pos + len]) len++;
          if (len > best) {
            candLen[count] = len;
            candDist[count] = dist;
            count++;
            best = len;
            if (len >= maxLen || len >= 64) break;
          }
        }
        p = this.prev[p - this.lo];
        depth++;
      }
      this.prev[pos - this.lo] = this.head[h];
      this.head[h] = pos;
    } else {
      // Too close to the end for a match; still insert for completeness.
      if (pos + 2 < n) {
        const h = (Math.imul(((d[pos] << 16) ^ (d[pos + 1] << 8) ^ d[pos + 2]) >>> 0, 2654435761) >>> 16) & 0xffff;
        this.prev[pos - this.lo] = this.head[h];
        this.head[h] = pos;
      }
    }
    return count;
  }
}

// One DP parse of block [lo, hi) under the given bit-cost tables.
// lenMode 'range': only lengths at a length-symbol range start, plus the max
// length. lenMode 'short': every length when the max is at most 64 (fine parse
// structure where it matters), else range starts plus the max length (stops
// inside a long run are rarely optimal, so enumerating them wastes time).
// Returns tokens packed in an Int32Array: literal = byte (0..255),
// match = (1<<25) | (len<<16) | dist. Also fills freqs (lit/len + dist).
function dpParse(data, lo, hi, litCost, lenCostForLen, distCostForDist, maxDepth, freqLit, freqDist, lenMode = 'short') {
  const m = hi - lo;
  const cost = new Float64Array(m + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const prevLen = new Int16Array(m + 1);
  const prevDist = new Int32Array(m + 1);
  const matcher = new Matcher(data, lo, hi);
  const candLen = new Int16Array(8);
  const candDist = new Int32Array(8);
  for (let i = 0; i < m; i++) {
    const c = cost[i];
    const pos = lo + i;
    // Literal.
    const lc = c + litCost[data[pos]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      prevLen[i + 1] = 1;
      prevDist[i + 1] = 0;
    }
    // Matches: lengths offered per lenMode (see header).
    if (i + 3 <= m) {
      const cnt = matcher.find(pos, maxDepth, candLen, candDist);
      for (let k = 0; k < cnt; k++) {
        const L = candLen[k];
        const dc = distCostForDist[candDist[k]];
        if (lenMode === 'short' && L <= 64) {
          for (let l = 3; l <= L; l++) {
            const nc = c + dc + lenCostForLen[l];
            if (nc < cost[i + l]) {
              cost[i + l] = nc;
              prevLen[i + l] = l;
              prevDist[i + l] = candDist[k];
            }
          }
        } else {
          for (let s = 0; s < 29; s++) {
            const l = LEN_BASE[s];
            if (l > L) break;
            const nc = c + dc + lenCostForLen[l];
            if (nc < cost[i + l]) {
              cost[i + l] = nc;
              prevLen[i + l] = l;
              prevDist[i + l] = candDist[k];
            }
          }
          if (L < 258) {
            const nc = c + dc + lenCostForLen[L];
            if (nc < cost[i + L]) {
              cost[i + L] = nc;
              prevLen[i + L] = L;
              prevDist[i + L] = candDist[k];
            }
          }
        }
      }
    } else {
      matcher.find(pos, maxDepth, candLen, candDist);
    }
  }
  // Backtrack into tokens (reversed first).
  const toks = new Int32Array(m);
  let t = 0;
  let i = m;
  while (i > 0) {
    const l = prevLen[i];
    const dist = prevDist[i];
    if (l === 1 && dist === 0) {
      const b = data[lo + i - 1];
      toks[t++] = b;
      freqLit[b]++;
      i -= 1;
    } else {
      toks[t++] = (1 << 25) | (l << 16) | dist;
      freqLit[LEN_SYM[l]]++;
      freqDist[DIST_SYM[dist]]++;
      i -= l;
    }
  }
  freqLit[256]++;
  // Reverse in place.
  for (let a = 0, b = t - 1; a < b; a++, b--) {
    const tmp = toks[a];
    toks[a] = toks[b];
    toks[b] = tmp;
  }
  return toks.subarray(0, t);
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Writes one dynamic-Huffman block (tokens of one DP parse) into the writer.
function writeBlock(w, toks, isLast, litLen, distLen) {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  // Trim trailing zero lengths: HLIT >= 257, HDIST >= 1.
  let hlit = 257;
  for (let s = 286; s > 257; s--) if (litLen[s - 1] !== 0) { hlit = s; break; }
  let hdist = 1;
  for (let s = 30; s > 1; s--) if (distLen[s - 1] !== 0) { hdist = s; break; }
  // RLE-encode the lit+dist lengths.
  const seq = [];
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const n = Math.min(left, 138);
        seq.push([18, n - 11]);
        left -= n;
      }
      if (left >= 3) {
        seq.push([17, left - 3]);
        left = 0;
      }
      while (left-- > 0) seq.push([0, 0]);
    } else {
      seq.push([v, 0]);
      let left = run - 1;
      while (left >= 3) {
        const n = Math.min(left, 6);
        seq.push([16, n - 3]);
        left -= n;
      }
      while (left-- > 0) seq.push([v, 0]);
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of seq) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 4;
  for (let s = 19; s > 4; s--) if (clLen[CL_ORDER[s - 1]] !== 0) { hclen = s; break; }
  w.write(isLast ? 1 : 0, 1);
  w.write(2, 2); // dynamic Huffman
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let s = 0; s < hclen; s++) w.write(clLen[CL_ORDER[s]], 3);
  for (const [s, extra] of seq) {
    w.write(clCode[s], clLen[s]);
    if (s === 16) w.write(extra, 2);
    else if (s === 17) w.write(extra, 3);
    else if (s === 18) w.write(extra, 7);
  }
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok < 0x10000) {
      w.write(litCode[tok], litLen[tok]);
    } else {
      const len = (tok >>> 16) & 0x1ff;
      const dist = tok & 0xffff;
      const ls = LEN_SYM[len];
      w.write(litCode[ls], litLen[ls]);
      const le = LEN_EXTRA[ls - 257];
      if (le > 0) w.write(len - LEN_BASE[ls - 257], le);
      const ds = DIST_SYM[dist];
      w.write(distCode[ds], distLen[ds]);
      const de = DIST_EXTRA[ds];
      if (de > 0) w.write(dist - DIST_BASE[ds], de);
    }
  }
  w.write(litCode[256], litLen[256]);
}

// Optimal-parse deflate of `data` (Uint8Array) -> a zlib stream (Uint8Array).
// iterations: DP passes (1 = a single fixed-cost pass; the old 2-pass form
// cost ~2x the time for a small gain and is dropped for the 60 s wall).
// maxDepth: hash-chain depth. blockSize: bytes per dynamic block.
function deflateDP(data, iterations = 2, maxDepth = 96, blockSize = 262144) {
  const n = data.length;
  // Fixed-Huffman cost model for the first pass.
  const fixedLit = new Float64Array(286);
  for (let s = 0; s < 286; s++) fixedLit[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  const fixedLenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) fixedLenCost[l] = fixedLit[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
  const fixedDistCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) fixedDistCost[d] = 5;
  const w = new BitWriter(n + 65536);
  const nBlocks = Math.max(1, Math.ceil(n / blockSize));
  for (let b = 0; b < nBlocks; b++) {
    const lo = b * blockSize;
    const hi = Math.min(n, lo + blockSize);
    let litCost = fixedLit;
    let lenCost = fixedLenCost;
    let distCost = fixedDistCost;
    let toks = null;
    let litLen = null;
    let distLen = null;
    for (let it = 0; it < iterations; it++) {
      const freqLit = new Uint32Array(286);
      const freqDist = new Uint32Array(30);
      // First pass is cheap (shallow chains, range-starts only): it only has to
      // build a good cost model. Later passes run the full search.
      const cheap = it === 0 && iterations > 1;
      toks = dpParse(data, lo, hi, litCost, lenCost, distCost, cheap ? 16 : maxDepth, freqLit, freqDist, 'range');
      litLen = buildLengths(freqLit, 15);
      // A block with no match still needs one distance code.
      if (freqDist.every((f) => f === 0)) freqDist[0] = 1;
      distLen = buildLengths(freqDist, 15);
      if (it + 1 < iterations) {
        const lc = new Float64Array(286);
        for (let s = 0; s < 286; s++) lc[s] = litLen[s];
        const lenc = new Float64Array(259);
        for (let l = 3; l <= 258; l++) lenc[l] = litLen[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
        const dc = new Float64Array(32769);
        for (let d = 1; d <= 32768; d++) dc[d] = distLen[DIST_SYM[d]] + DIST_EXTRA[DIST_SYM[d]];
        litCost = lc;
        lenCost = lenc;
        distCost = dc;
      }
    }
    writeBlock(w, toks, b === nBlocks - 1 ? 1 : 0, litLen, distLen);
  }
  const deflated = w.finish();
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflated, 2);
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 4, adler32(data));
  return out;
}

// ---------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(readFileSync(join(I, id, 'image.png')));
  const { winner, brute } = screen(rgba, width, height);
  const form = winner.form;
  // Optimal-parse deflate of the winner; keep zlib level 9 when it is smaller.
  let best = winner.zlib;
  let dpWinner = null;
  try {
    dpWinner = deflateDP(winner.data, 1, 24, 524288);
    if (dpWinner.length < best.length) best = dpWinner;
  } catch (e) {
    process.stderr.write(`${id} deflateDP failed (${e.message}), using zlib\n`);
  }
  // (No brute-force filter anymore: it cost ~3600 deflateSync calls per form
  // and the DP second run, for a marginal size gain. Time is the constraint.)
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', best]);
  chunks.push(['IEND', new Uint8Array(0)]);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOf(chunks));
  process.stderr.write(`${id} ct=${form.colourType} ${best.length + chunkBytes(form)} bytes (zlib9 ${winner.zlib.length + chunkBytes(form)})\n`);
}
