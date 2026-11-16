// Source map `mappings` (VLQ, one source), decoded for looking positions up: the transpiler's (transpile-wasm's
// SOURCE_MAP) maps for served modules, which the worker uses to show stack frames and source previews in the files'
// own lines, as Bun does. V8 doesn't apply source maps to `Error.stack`.

/** Per generated line, its segments as [generated column, original line, original column] (all 0-based). */
export type Mappings = Int32Array[];

const DIGITS = new Int8Array(128).fill(-1);
for (const [i, c] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) DIGITS[c.charCodeAt(0)] = i;

export function decodeMappings(mappings: string): Mappings {
  const lines: Mappings = [];
  let segs: number[] = [];
  let srcLine = 0;
  let srcCol = 0;
  let genCol = 0;
  let field = 0;
  const seg: number[] = [0, 0, 0, 0, 0];
  let value = 0;
  let shift = 0;
  const endSegment = () => {
    if (field === 0) return;
    genCol += seg[0];
    if (field >= 4) {
      srcLine += seg[2];
      srcCol += seg[3];
      segs.push(genCol, srcLine, srcCol);
    }
    field = 0;
  };
  for (let i = 0; i <= mappings.length; i++) {
    const c = i < mappings.length ? mappings.charCodeAt(i) : 59; // ";" at the end
    if (c === 59 || c === 44) {
      endSegment();
      if (c === 59) {
        lines.push(Int32Array.from(segs));
        segs = [];
        genCol = 0;
      }
      continue;
    }
    const digit = c < 128 ? DIGITS[c] : -1;
    if (digit < 0) continue;
    value |= (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    seg[field++] = value & 1 ? -(value >>> 1) : value >>> 1;
    value = 0;
    shift = 0;
  }
  return lines;
}

/** The original 0-based [line, column] of a generated 0-based position: the closest segment at or before it. */
export function originalPosition(map: Mappings, line: number, column: number): [number, number] | undefined {
  const segs = map[line];
  if (!segs || !segs.length) return undefined;
  let found = -1;
  for (let i = 0; i < segs.length; i += 3) {
    if (segs[i] > column) break;
    found = i;
  }
  if (found < 0) found = 0;
  return [segs[found + 1], segs[found + 2]];
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * `mappings` with the generated columns of the first line moved by `by` (only its first segment's is absolute): for
 * text put before the printed code on its first line, as transpile-wasm does for its own (`shift_first_column`).
 */
export function shiftFirstColumn(mappings: string, by: number): string {
  if (!by || !mappings || mappings[0] === ";") return mappings;
  let value = 0;
  let shift = 0;
  let end = 0;
  for (let i = 0; i < mappings.length; i++) {
    const digit = DIGITS[mappings.charCodeAt(i)] ?? -1;
    if (digit < 0) return mappings;
    value |= (digit & 31) << shift;
    shift += 5;
    if (!(digit & 32)) {
      end = i + 1;
      break;
    }
  }
  const column = (value & 1 ? -(value >>> 1) : value >>> 1) + by;
  let vlq = column < 0 ? (-column << 1) | 1 : column << 1;
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += BASE64[digit];
  } while (vlq > 0);
  return out + mappings.slice(end);
}

/** The length of `text`'s first line. */
export const firstLineLength = (text: string) => {
  const nl = text.indexOf("\n");
  return nl < 0 ? text.length : nl;
};

/**
 * `mappings` with generated columns moved for text inserted into the printed code: `inserts` per generated line are
 * `[column, length]` in column order (columns before the insert). A segment at or after an insert moves by its length.
 */
export function insertColumns(mappings: string, inserts: Map<number, [number, number][]>): string {
  if (!inserts.size) return mappings;
  const encode = (n: number) => {
    let vlq = n < 0 ? (-n << 1) | 1 : n << 1;
    let out = "";
    do {
      let digit = vlq & 31;
      vlq >>>= 5;
      if (vlq > 0) digit |= 32;
      out += BASE64[digit];
    } while (vlq > 0);
    return out;
  };
  return mappings
    .split(";")
    .map((line, i) => {
      const list = inserts.get(i);
      if (!list || !line) return line;
      let col = 0;
      let prevNew = 0;
      return line
        .split(",")
        .map((seg) => {
          // The first VLQ is the column delta; the rest stays as it is.
          let value = 0;
          let shift = 0;
          let end = 0;
          for (; end < seg.length; end++) {
            const digit = DIGITS[seg.charCodeAt(end)];
            value |= (digit & 31) << shift;
            shift += 5;
            if (!(digit & 32)) {
              end++;
              break;
            }
          }
          col += value & 1 ? -(value >>> 1) : value >>> 1;
          let moved = col;
          for (const [at, len] of list) if (at <= col) moved += len;
          const out = encode(moved - prevNew) + seg.slice(end);
          prevNew = moved;
          return out;
        })
        .join(",");
    })
    .join(";");
}
