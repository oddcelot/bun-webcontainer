import { codeError } from "./errors";

// node:module's SourceMap, as Bun implements it: a lookup from a position in generated code to its segment.

type Payload = { version?: number; sources?: string[]; names?: string[]; mappings: string; sourcesContent?: (string | null)[]; sourceRoot?: string };
/** One mapped segment; `{}` from findEntry when the line has none at or before the column. */
type Entry = { generatedLine: number; generatedColumn: number; originalLine: number; originalColumn: number; originalSource: string; name?: string };

const DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The segments of each generated line, in column order. A segment without a source (one field) maps nothing. */
function decode({ mappings, sources = [], names = [] }: Payload): Entry[][] {
  const lines: Entry[][] = [[]];
  // Each field is relative to the one before it; only the generated column starts over on a new line.
  let column = 0;
  let source = 0;
  let line = 0;
  let originalColumn = 0;
  let name: number | undefined;
  for (let i = 0; i < mappings.length; ) {
    const c = mappings[i];
    if (c === ";") {
      lines.push([]);
      column = 0;
      i++;
      continue;
    }
    if (c === ",") {
      i++;
      continue;
    }
    const fields: number[] = [];
    while (i < mappings.length && mappings[i] !== "," && mappings[i] !== ";") {
      let value = 0;
      let shift = 0;
      let digit: number;
      do {
        digit = DIGITS.indexOf(mappings[i++] ?? "");
        if (digit < 0) throw new Error(`Invalid source map mappings at ${i - 1}`);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      fields.push(value % 2 ? -(value - 1) / 2 : value / 2);
    }
    column += fields[0];
    if (fields.length < 4) continue;
    source += fields[1];
    line += fields[2];
    originalColumn += fields[3];
    if (source < 0 || source >= sources.length) throw new Error(`Invalid source index value at ${i - 1}`);
    // A name stays until the next segment that has one, as in Bun.
    if (fields.length > 4) name = (name ?? 0) + fields[4];
    const entry: Entry = { generatedLine: lines.length - 1, generatedColumn: column, originalLine: line, originalColumn, originalSource: sources[source] };
    if (name !== undefined && names[name] !== undefined) entry.name = names[name];
    lines.at(-1)!.push(entry);
  }
  return lines;
}

export class SourceMap {
  #payload: Payload;
  #lineLengths: number[] | undefined;
  #lines: Entry[][];

  constructor(payload: Payload, options?: { lineLengths?: number[] }) {
    if (typeof payload !== "object" || payload === null) {
      const got = payload === undefined || payload === null ? String(payload) : `type ${typeof payload} (${typeof payload === "string" ? `'${payload}'` : String(payload)})`;
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "payload" argument must be of type object. Received ${got}`);
    }
    if (typeof payload.mappings !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "payload 'mappings' must be a string");
    this.#payload = payload;
    this.#lineLengths = options?.lineLengths;
    this.#lines = decode(payload);
  }

  get payload() {
    return this.#payload;
  }

  get lineLengths() {
    return this.#lineLengths;
  }

  /** The segment at or before a 0-based position on its generated line; `{}` when that line has none there. */
  findEntry(lineOffset: number, columnOffset: number): Entry | {} {
    const column = Math.trunc(columnOffset);
    let found: Entry | undefined;
    for (const entry of this.#lines[Math.trunc(lineOffset)] ?? []) {
      if (entry.generatedColumn > column) break;
      found = entry;
    }
    return found ? { ...found } : {};
  }

  /** A 1-based position in generated code as its 1-based position in the source; `{}` when it isn't mapped. */
  findOrigin(lineNumber: number, columnNumber: number): { name?: string; fileName: string; lineNumber: number; columnNumber: number } | {} {
    const entry = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (!("originalSource" in entry)) return {};
    const columnNumberInSource = entry.originalColumn + (columnNumber - 1 - entry.generatedColumn) + 1;
    return { name: entry.name, fileName: entry.originalSource, lineNumber: entry.originalLine + 1, columnNumber: columnNumberInSource };
  }
}
