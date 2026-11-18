// Bun's character diff (bun/src/text_diff/lib.rs, `CharDiff::diff`), which `bun test` uses to highlight what changed
// within a modified line: Myers' bidirectional search with its work bounds, then diff-match-patch's merge and semantic
// cleanups. Over UTF-8 bytes; the hunks fall on character boundaries. Ported step for step so that it picks the same
// hunks as Bun (the highlights, and where a long line is cut, depend on them).

/** `a[aLo..aHi]` was replaced by `b[bLo..bHi]`; between two hunks both sides are equal. */
export type Hunk = { aLo: number; aHi: number; bLo: number; bHi: number };
type Bytes = Uint8Array;

const deleted = (h: Hunk) => h.aHi - h.aLo;
const inserted = (h: Hunk) => h.bHi - h.bLo;

function commonPrefix(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
const equalBytes = (a: Bytes, b: Bytes) => a.length === b.length && commonPrefix(a, b) === a.length;

/** Whether `s[i]` exists and is a UTF-8 continuation byte. */
export const isUtf8Cont = (s: Bytes, i: number) => i < s.length && (s[i] & 0xc0) === 0x80;

function indexOf(hay: Bytes, needle: Bytes): number {
  if (!needle.length) return 0;
  const first = needle[0];
  for (let at = 0; at + needle.length <= hay.length; at++) {
    if (hay[at] !== first) continue;
    let k = 1;
    while (k < needle.length && hay[at + k] === needle[k]) k++;
    if (k === needle.length) return at;
  }
  return -1;
}

const isqrt = (n: number) => {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
};

// ---- Myers ----

const NONE = -(2 ** 30);
const MAX_LEN = Math.floor(0x7fffffff / 4);
const MIN_PROBE = 64;
const CHARS = { probe: 256, exhaustiveMax: 2048, exhaustivePerElem: 1024, exhaustiveQuota: 40_000_000, work: 4_000_000 };
const CHAR_WORK_PER_BYTE = 2;
const exhaustiveDepth = (n: number) => Math.min(CHARS.exhaustiveMax, isqrt(n * CHARS.exhaustivePerElem), Math.floor(CHARS.exhaustiveQuota / Math.max(n, 1)));

type Point = [number, number];
type Job = { aStart: number; aEnd: number; bStart: number; bEnd: number; probe: number; exhaustive: boolean };
const job = ([aStart, bStart]: Point, [aEnd, bEnd]: Point, probe: number, exhaustive: boolean): Job => ({ aStart, aEnd, bStart, bEnd, probe, exhaustive });
type Split = { exact: Point } | { greedy: [Point, Point] };

/** `[-d, d]` clipped to the grid (`-m ≤ k ≤ n`), keeping k ≡ d (mod 2). */
function diagRange(d: number, n: number, m: number): [number, number] {
  let lo = -d;
  if (lo < -m) lo = -m + ((d - m) & 1);
  let hi = d;
  if (hi > n) hi = n - ((d - n) & 1);
  return [lo, hi];
}

class Myers {
  workLeft: number;
  constructor(
    readonly a: Bytes,
    readonly b: Bytes,
    work: number,
  ) {
    this.workLeft = work;
  }

  /** Marks every element of `a` / `b` that is not part of a longest common subsequence as changed. */
  run(changedA: boolean[], changedB: boolean[]) {
    const { a, b } = this;
    const fill = (arr: boolean[], lo: number, hi: number) => {
      for (let i = lo; i < hi; i++) arr[i] = true;
    };
    const stack: Job[] = [job([0, 0], [a.length, b.length], CHARS.probe, true)];
    for (let j = stack.pop(); j; j = stack.pop()) {
      let { aStart, aEnd, bStart, bEnd } = j;
      const { probe, exhaustive } = j;
      const p = commonPrefix(a.subarray(aStart, aEnd), b.subarray(bStart, bEnd));
      aStart += p;
      bStart += p;
      const s = commonSuffix(a.subarray(aStart, aEnd), b.subarray(bStart, bEnd));
      aEnd -= s;
      bEnd -= s;
      if (aStart === aEnd) {
        fill(changedB, bStart, bEnd);
        continue;
      }
      if (bStart === bEnd) {
        fill(changedA, aStart, aEnd);
        continue;
      }
      if (aEnd - aStart === 1) {
        fill(changedB, bStart, bEnd);
        const at = b.subarray(bStart, bEnd).indexOf(a[aStart]);
        if (at >= 0) changedB[bStart + at] = false;
        else changedA[aStart] = true;
        continue;
      }
      if (bEnd - bStart === 1) {
        fill(changedA, aStart, aEnd);
        const at = a.subarray(aStart, aEnd).indexOf(b[bStart]);
        if (at >= 0) changedA[aStart + at] = false;
        else changedB[bStart] = true;
        continue;
      }
      if (this.workLeft <= 0) {
        fill(changedA, aStart, aEnd);
        fill(changedB, bStart, bEnd);
        continue;
      }
      const tryExact = (depth: number, ex: boolean): [Point, Point] | undefined => {
        const split = this.middle(aStart, aEnd, bStart, bEnd, depth);
        if ("exact" in split) {
          const [x, y] = split.exact;
          if ((x !== aStart || y !== bStart) && (x !== aEnd || y !== bEnd)) {
            stack.push(job([aStart, bStart], [x, y], probe, ex));
            stack.push(job([x, y], [aEnd, bEnd], probe, ex));
            return undefined;
          }
          return [
            [aStart, bStart],
            [aStart, bStart],
          ];
        }
        return split.greedy;
      };
      let fr = tryExact(probe, exhaustive);
      if (!fr) continue;
      if (exhaustive) {
        const depth = Math.min(exhaustiveDepth(aEnd - aStart + (bEnd - bStart)), isqrt(Math.floor(Math.max(this.workLeft, 0) / 2)));
        if (depth > probe) {
          fr = tryExact(depth, true);
          if (!fr) continue;
        }
      }
      const [f, r] = fr;
      const inside = (q: Point) => !(q[0] === aStart && q[1] === bStart) && !(q[0] === aEnd && q[1] === bEnd);
      const cuts: Point[] = [[aStart, bStart]];
      if (inside(f)) cuts.push(f);
      if (inside(r) && (cuts.length === 1 || (f[0] <= r[0] && f[1] <= r[1] && !(f[0] === r[0] && f[1] === r[1])))) cuts.push(r);
      if (cuts.length === 1) {
        fill(changedA, aStart, aEnd);
        fill(changedB, bStart, bEnd);
        continue;
      }
      cuts.push([aEnd, bEnd]);
      const next = Math.max(Math.floor(probe / 2), MIN_PROBE);
      for (let c = 0; c + 1 < cuts.length; c++) stack.push(job(cuts[c], cuts[c + 1], next, false));
    }
  }

  /** Bidirectional search for a point on an optimal path through the box, giving up after `depth` steps from each end. */
  middle(aStart: number, aEnd: number, bStart: number, bEnd: number, depth: number): Split {
    const a = this.a.subarray(aStart, aEnd);
    const b = this.b.subarray(bStart, bEnd);
    const n = a.length;
    const m = b.length;
    const delta = n - m;
    const dmax = Math.floor((n + m + 1) / 2);
    const bmax = Math.min(dmax, depth);
    const off = bmax + 1;
    const size = 2 * bmax + 3;
    const vf = new Int32Array(size).fill(NONE);
    const vb = new Int32Array(size).fill(NONE);
    vf[off + 1] = 0;
    vb[off + 1] = 0;
    const front = (delta & 1) !== 0;
    // Forward on `a`/`b`; reverse on them mirrored (x counts elements taken from the end).
    const fwdAt = (s: Bytes, i: number) => s[i];
    const revAt = (s: Bytes, i: number) => s[s.length - 1 - i];
    const fwdSnake = (x: number, y: number) => commonPrefix(a.subarray(x + 1), b.subarray(y + 1));
    const revSnake = (x: number, y: number) => commonSuffix(a.subarray(0, n - x - 1), b.subarray(0, m - y - 1));
    /** One step `d` of one direction: the found point, if the fronts met. */
    const walk = (v: Int32Array, other: Int32Array, d: number, at: typeof fwdAt, snake: typeof fwdSnake, check: boolean, cd: number): [number, number] | undefined => {
      let [k, kmax] = diagRange(d, n, m);
      const clo = delta - cd;
      const chi = delta + cd;
      let lim = n < m + k ? n : m + k;
      let i = k + off;
      let lo = v[i - 1];
      while (k <= kmax) {
        const hi = v[i + 1];
        let x = lo + 1 > hi ? lo + 1 : hi;
        if (x > lim) {
          x = lo + 1 < hi ? lo + 1 : hi;
          if (x < 0 || x > lim) x = v[i];
        }
        if (x >= 0) {
          const y = x - k;
          if (x < n && y < m && at(a, x) === at(b, y)) x += 1 + snake(x, y);
          v[i] = x;
          if (check && k >= clo && k <= chi) {
            const x2 = other[delta - k + off];
            if (x2 >= 0 && x + x2 >= n) return [x, k];
          }
        }
        lo = hi;
        k += 2;
        i += 2;
        lim = lim + 2 < n ? lim + 2 : n;
      }
      return undefined;
    };
    for (let d = 0; d <= bmax; d++) {
      const f = walk(vf, vb, d, fwdAt, fwdSnake, front, d - 1);
      if (f) {
        this.workLeft -= (d + 1) * (d + 1);
        return { exact: [aStart + f[0], bStart + f[0] - f[1]] };
      }
      const r = walk(vb, vf, d, revAt, revSnake, !front, d);
      if (r) {
        const k = delta - r[1];
        const x = vf[k + off];
        this.workLeft -= (d + 1) * (d + 2);
        return { exact: [aStart + x, bStart + x - k] };
      }
    }
    this.workLeft -= (bmax + 1) * (bmax + 2);
    const best = (v: Int32Array): Point => {
      let top = -1;
      let pt: Point = [0, 0];
      for (let k = -bmax; k <= bmax; k++) {
        const x = v[k + off];
        if (x >= 0 && x - k <= m && 2 * x - k > top) (top = 2 * x - k), (pt = [x, x - k]);
      }
      return pt;
    };
    const [fx, fy] = best(vf);
    const [bx, by] = best(vb);
    return {
      greedy: [
        [aStart + fx, bStart + fy],
        [aStart + (n - bx), bStart + (m - by)],
      ],
    };
  }
}

function pushTrimmed(a: Bytes, b: Bytes, h: Hunk, out: Hunk[]) {
  const p = commonPrefix(a.subarray(h.aLo, h.aHi), b.subarray(h.bLo, h.bHi));
  h.aLo += p;
  h.bLo += p;
  const s = commonSuffix(a.subarray(h.aLo, h.aHi), b.subarray(h.bLo, h.bHi));
  h.aHi -= s;
  h.bHi -= s;
  if (h.aLo < h.aHi || h.bLo < h.bHi) out.push(h);
}

/** Maximal runs of changed elements as hunks. */
function hunksFromChanged(a: Bytes, b: Bytes, changedA: boolean[], changedB: boolean[], out: Hunk[]) {
  const n = changedA.length;
  const m = changedB.length;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !changedA[i] && !changedB[j]) {
      i++;
      j++;
      continue;
    }
    const aLo = i;
    const bLo = j;
    while (i < n && changedA[i]) i++;
    while (j < m && changedB[j]) j++;
    pushTrimmed(a, b, { aLo, aHi: i, bLo, bHi: j }, out);
  }
}

const pushNonempty = (hunks: Hunk[], h: Hunk) => void ((h.aLo < h.aHi || h.bLo < h.bHi) && hunks.push(h));

/** Raw hunks for `a` vs `b`, before cleanup. */
function whole(a: Bytes, b: Bytes): Hunk[] {
  const hunks: Hunk[] = [];
  const p = commonPrefix(a, b);
  if (p === a.length && p === b.length) return hunks;
  const s = commonSuffix(a.subarray(p), b.subarray(p));
  const ma = a.subarray(p, a.length - s);
  const mb = b.subarray(p, b.length - s);
  const all = { aLo: 0, aHi: ma.length, bLo: 0, bHi: mb.length };
  const longIsA = ma.length >= mb.length;
  const at = !ma.length || !mb.length ? -1 : longIsA ? indexOf(ma, mb) : indexOf(mb, ma);
  if (!ma.length || !mb.length) hunks.push(all);
  else if (at >= 0) {
    const [ga, gb] = longIsA ? [at, 0] : [0, at];
    const common = Math.min(ma.length, mb.length);
    pushNonempty(hunks, { aLo: 0, aHi: ga, bLo: 0, bHi: gb });
    pushNonempty(hunks, { aLo: ga + common, aHi: ma.length, bLo: gb + common, bHi: mb.length });
  } else if (ma.length === 1 || mb.length === 1 || Math.max(a.length, b.length) >= MAX_LEN) hunks.push(all);
  else {
    const changedA = new Array<boolean>(ma.length).fill(false);
    const changedB = new Array<boolean>(mb.length).fill(false);
    new Myers(ma, mb, CHARS.work + (ma.length + mb.length) * CHAR_WORK_PER_BYTE).run(changedA, changedB);
    hunksFromChanged(ma, mb, changedA, changedB, hunks);
  }
  for (const h of hunks) (h.aLo += p), (h.aHi += p), (h.bLo += p), (h.bHi += p);
  return hunks;
}

// ---- cleanup (diff-match-patch) ----

/** A pure insertion or deletion that repeats the equality next to it slides over it. Whether anything moved. */
function slideSingleEdits(hunks: Hunk[], a: Bytes, b: Bytes): boolean {
  let changed = false;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (deleted(h) > 0 && inserted(h) > 0) continue;
    const prevA = i === 0 ? 0 : hunks[i - 1].aHi;
    const nextA = i + 1 === hunks.length ? a.length : hunks[i + 1].aLo;
    const before = h.aLo - prevA;
    const after = nextA - h.aHi;
    if (before === 0 || after === 0) continue;
    const [seq, lo, hi] = deleted(h) > 0 ? [a, h.aLo, h.aHi] : [b, h.bLo, h.bHi];
    const edit = seq.subarray(lo, hi);
    let by: number;
    if (edit.length >= before && equalBytes(edit.subarray(edit.length - before), seq.subarray(lo - before, lo))) by = -before;
    else if (edit.length >= after && equalBytes(edit.subarray(0, after), seq.subarray(hi, hi + after))) by = after;
    else continue;
    hunks[i] = { aLo: h.aLo + by, aHi: h.aHi + by, bLo: h.bLo + by, bHi: h.bHi + by };
    changed = true;
  }
  return changed;
}

function cleanupMerge(hunks: Hunk[], a: Bytes, b: Bytes) {
  for (;;) {
    let w = 0;
    for (let r = 0; r < hunks.length; r++) {
      const h = { ...hunks[r] };
      if (h.aLo < h.aHi && h.bLo < h.bHi) {
        const p = commonPrefix(a.subarray(h.aLo, h.aHi), b.subarray(h.bLo, h.bHi));
        h.aLo += p;
        h.bLo += p;
        const s = commonSuffix(a.subarray(h.aLo, h.aHi), b.subarray(h.bLo, h.bHi));
        h.aHi -= s;
        h.bHi -= s;
        if (h.aLo === h.aHi && h.bLo === h.bHi) continue;
      }
      if (w > 0 && hunks[w - 1].aHi === h.aLo && hunks[w - 1].bHi === h.bLo) {
        hunks[w - 1].aHi = h.aHi;
        hunks[w - 1].bHi = h.bHi;
      } else hunks[w++] = h;
    }
    hunks.length = w;
    if (!slideSingleEdits(hunks, a, b)) return;
  }
}

const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isControl = (c: number) => c < 0x20 || c === 0x7f;
const startsWith = (s: Bytes, p: string) => s.length >= p.length && [...p].every((ch, i) => s[i] === ch.charCodeAt(0));
const endsWith = (s: Bytes, p: string) => s.length >= p.length && [...p].every((ch, i) => s[s.length - p.length + i] === ch.charCodeAt(0));

/** How good a boundary between `one` and `two` is: 6 (best) to 0. */
function semanticScore(one: Bytes, two: Bytes): number {
  if (!one.length || !two.length) return 6;
  const c1 = one[one.length - 1];
  const c2 = two[0];
  const nonAlnum1 = !isAlnum(c1);
  const nonAlnum2 = !isAlnum(c2);
  const ws1 = nonAlnum1 && isSpace(c1);
  const ws2 = nonAlnum2 && isSpace(c2);
  const lb1 = ws1 && isControl(c1);
  const lb2 = ws2 && isControl(c2);
  const blank1 = lb1 && (endsWith(one, "\n\n") || endsWith(one, "\n\r\n"));
  const blank2 = lb2 && (startsWith(two, "\n\n") || startsWith(two, "\r\n\n") || startsWith(two, "\n\r\n") || startsWith(two, "\r\n\r\n"));
  if (blank1 || blank2) return 5;
  if (lb1 || lb2) return 4;
  if (nonAlnum1 && !ws1 && ws2) return 3;
  if (ws1 || ws2) return 2;
  if (nonAlnum1 || nonAlnum2) return 1;
  return 0;
}

function cleanupSemanticLossless(hunks: Hunk[], a: Bytes, b: Bytes) {
  let w = 0;
  for (let r = 0; r < hunks.length; r++) {
    const h = hunks[r];
    const prevA = w === 0 ? 0 : hunks[w - 1].aHi;
    const nextA = r + 1 === hunks.length ? a.length : hunks[r + 1].aLo;
    const before = h.aLo - prevA;
    const after = nextA - h.aHi;
    if (before === 0 || after === 0 || (deleted(h) > 0 && inserted(h) > 0)) {
      hunks[w++] = h;
      continue;
    }
    const seq = deleted(h) > 0 ? a : b;
    let lo = deleted(h) > 0 ? h.aLo : h.bLo;
    let hi = deleted(h) > 0 ? h.aHi : h.bHi;
    const origLo = lo;
    const eq1Start = lo - before;
    const eq2End = hi + after;
    let shift = commonSuffix(seq.subarray(eq1Start, lo), seq.subarray(lo, hi));
    while (shift > 0 && isUtf8Cont(seq, lo - shift)) shift--;
    lo -= shift;
    hi -= shift;
    const score = () => semanticScore(seq.subarray(eq1Start, lo), seq.subarray(lo, hi)) + semanticScore(seq.subarray(lo, hi), seq.subarray(hi, eq2End));
    let bestLo = lo;
    let bestScore = score();
    while (hi < eq2End && seq[lo] === seq[hi]) {
      lo++;
      hi++;
      if (isUtf8Cont(seq, lo)) continue;
      const s = score();
      if (s >= bestScore) (bestLo = lo), (bestScore = s);
    }
    const dl = bestLo - origLo;
    const moved = { aLo: h.aLo + dl, aHi: h.aHi + dl, bLo: h.bLo + dl, bHi: h.bHi + dl };
    if (r + 1 < hunks.length && moved.aHi === hunks[r + 1].aLo && moved.bHi === hunks[r + 1].bLo) {
      hunks[r + 1] = { ...hunks[r + 1], aLo: moved.aLo, bLo: moved.bLo };
    } else if (w > 0 && hunks[w - 1].aHi === moved.aLo && hunks[w - 1].bHi === moved.bLo) {
      hunks[w - 1] = { ...hunks[w - 1], aHi: moved.aHi, bHi: moved.bHi };
    } else hunks[w++] = moved;
  }
  hunks.length = w;
}

const OVERLAP_MAX = 64 << 10;

/** Length of the longest suffix of `x` that is a prefix of `y`. */
function commonOverlap(x: Bytes, y: Bytes): number {
  const n = Math.min(x.length, y.length, OVERLAP_MAX);
  if (n === 0) return 0;
  x = x.subarray(x.length - n);
  y = y.subarray(0, n);
  if (equalBytes(x, y)) return n;
  if (n <= 16) {
    for (let k = n - 1; k >= 1; k--) if (equalBytes(x.subarray(n - k), y.subarray(0, k))) return k;
    return 0;
  }
  const fail = new Uint32Array(n);
  let k = 0;
  for (let i = 1; i < n; i++) {
    while (k > 0 && y[i] !== y[k]) k = fail[k - 1];
    if (y[i] === y[k]) k++;
    fail[i] = k;
  }
  k = 0;
  for (const c of x) {
    while (k > 0 && c !== y[k]) k = fail[k - 1];
    if (c === y[k]) k++;
    if (k === n) k = fail[k - 1];
  }
  return k;
}

function cleanupSemantic(hunks: Hunk[], a: Bytes, b: Bytes): Hunk[] {
  // An equality no longer than the edits on either side of it folds into one larger edit.
  let changed = false;
  let w = 0;
  for (let r = 0; r < hunks.length; r++) {
    let cur = hunks[r];
    while (w > 0) {
      const l = hunks[w - 1];
      const gap = cur.aLo - l.aHi;
      if (gap <= Math.max(deleted(l), inserted(l)) && gap <= Math.max(deleted(cur), inserted(cur))) {
        cur = { aLo: l.aLo, aHi: cur.aHi, bLo: l.bLo, bHi: cur.bHi };
        w--;
        changed = true;
      } else break;
    }
    hunks[w++] = cur;
  }
  hunks.length = w;
  if (changed) cleanupMerge(hunks, a, b);
  cleanupSemanticLossless(hunks, a, b);
  // `<del>abcxxx</del><ins>xxxdef</ins>` → `<del>abc</del>xxx<ins>def</ins>` (and the mirror case).
  const out: Hunk[] = [];
  for (const h of hunks) {
    const del = a.subarray(h.aLo, h.aHi);
    const ins = b.subarray(h.bLo, h.bHi);
    if (!del.length || !ins.length) {
      out.push(h);
      continue;
    }
    const fwd = commonOverlap(del, ins);
    const rev = commonOverlap(ins, del);
    if (fwd >= rev) {
      if (fwd > 0 && (fwd * 2 >= del.length || fwd * 2 >= ins.length)) {
        pushNonempty(out, { aLo: h.aLo, aHi: h.aHi - fwd, bLo: h.bLo, bHi: h.bLo });
        pushNonempty(out, { aLo: h.aHi, aHi: h.aHi, bLo: h.bLo + fwd, bHi: h.bHi });
        continue;
      }
    } else if (rev * 2 >= del.length || rev * 2 >= ins.length) {
      pushNonempty(out, { aLo: h.aLo, aHi: h.aLo, bLo: h.bLo, bHi: h.bHi - rev });
      pushNonempty(out, { aLo: h.aLo + rev, aHi: h.aHi, bLo: h.bHi, bHi: h.bHi });
      continue;
    }
    out.push(h);
  }
  return out;
}

/** Widens each hunk so that no edge falls inside a UTF-8 sequence; hunks that come to touch merge. */
function alignToCharacters(hunks: Hunk[], a: Bytes) {
  let w = 0;
  let r = 0;
  while (r < hunks.length) {
    const h = { ...hunks[r] };
    r++;
    const floor = w === 0 ? 0 : hunks[w - 1].aHi;
    while (h.aLo > floor && isUtf8Cont(a, h.aLo)) h.aLo--, h.bLo--;
    for (;;) {
      const ceil = r < hunks.length ? hunks[r].aLo : a.length;
      while (h.aHi < ceil && isUtf8Cont(a, h.aHi)) h.aHi++, h.bHi++;
      if (r < hunks.length && h.aHi === hunks[r].aLo) {
        h.aHi = hunks[r].aHi;
        h.bHi = hunks[r].bHi;
        r++;
        continue;
      }
      break;
    }
    hunks[w++] = h;
  }
  hunks.length = w;
}

/** Bun's character diff of `a` and `b` with semantic cleanup: byte offsets on character boundaries. */
export function charDiff(a: Bytes, b: Bytes): Hunk[] {
  let hunks = whole(a, b);
  cleanupMerge(hunks, a, b);
  alignToCharacters(hunks, a);
  hunks = cleanupSemantic(hunks, a, b);
  alignToCharacters(hunks, a);
  return hunks;
}
