// `echo`: bun/src/runtime/shell/builtin/echo.rs
import type { Command } from "../interp";
import { out } from "./util";

const NL = 0x0a;
const enc = new TextEncoder();
const SPACE = new Uint8Array([0x20]);
const NEWLINE = new Uint8Array([NL]);
const SIMPLE: Record<string, number> = { "\\": 0x5c, a: 0x07, b: 0x08, e: 0x1b, E: 0x1b, f: 0x0c, n: NL, r: 0x0d, t: 0x09, v: 0x0b };

/** `-e`'s escapes appended to `output`; true at `\c` (no more output at all). */
function appendWithEscapes(output: number[], input: Uint8Array): boolean {
  let i = 0;
  while (i < input.length) {
    if (input[i] !== 0x5c || i + 1 >= input.length) {
      output.push(input[i++]!);
      continue;
    }
    const c = String.fromCharCode(input[i + 1]!);
    if (c === "c") return true;
    if (Object.hasOwn(SIMPLE, c)) {
      output.push(SIMPLE[c]!);
      i += 2;
    } else if (c === "0") {
      i += 2;
      let val = 0;
      for (let digits = 0; digits < 3 && i < input.length && input[i]! >= 0x30 && input[i]! <= 0x37; digits++) val = (val * 8 + input[i++]! - 0x30) & 0xff;
      output.push(val);
    } else if (c === "x") {
      i += 2;
      let val = 0;
      let n = 0;
      for (; n < 2 && i + n < input.length; n++) {
        const d = parseInt(String.fromCharCode(input[i + n]!), 16);
        if (Number.isNaN(d)) break;
        val = (val << 4) | d;
      }
      i += n;
      if (n > 0) output.push(val);
      else output.push(0x5c, 0x78);
    } else {
      output.push(0x5c, input[i + 1]!);
      i += 2;
    }
  }
  return false;
}

/** bun_core::strings::trim_subsequent_leading_chars: a trailing run of `char` kept to one (the first byte always stays). */
function trimTrailingRun(s: Uint8Array, char: number): Uint8Array {
  if (!s.length) return s;
  let end = s.length - 1;
  let endend = s.length;
  while (end > 0 && s[end] === char) {
    endend = end + 1;
    end--;
  }
  return s.subarray(0, endend);
}

export const echo: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  let noNewline = false;
  let escapes = false;
  let start = 0;
  for (const flag of args) {
    if (flag.length < 2 || flag[0] !== "-" || !/^[neE]+$/.test(flag.slice(1))) break;
    for (const c of flag.slice(1)) {
      if (c === "n") noNewline = true;
      else escapes = c === "e";
    }
    start++;
  }

  const words = args.slice(start).map((a) => enc.encode(a));
  const parts: Uint8Array[] = [];
  let leadingNewline = false;
  let stop = false;
  for (const [i, arg] of words.entries()) {
    if (stop) break;
    const last = i === words.length - 1;
    if (escapes) {
      const bytes: number[] = [];
      stop = appendWithEscapes(bytes, arg);
      parts.push(new Uint8Array(bytes));
    } else if (last) {
      if (arg.at(-1) === NL) leadingNewline = true;
      parts.push(trimTrailingRun(arg, NL));
    } else parts.push(arg);
    if (!stop && !last) parts.push(SPACE);
  }
  if (!stop && !leadingNewline && !noNewline) parts.push(NEWLINE);
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    output.set(p, at);
    at += p.length;
  }
  await out(ctx, output);
  return 0;
};
