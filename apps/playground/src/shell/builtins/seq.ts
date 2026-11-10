// `seq`: bun/src/runtime/shell/builtin/seq.rs
import type { Command, CommandCtx } from "../interp";
import { err, out } from "./util";

const USAGE = "usage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last\n";
const f32 = Math.fround;

/**
 * bun_core::fmt::parse_f32: the whole word as a decimal number (WTF::parseDouble, leading spaces allowed), or
 * inf/infinity/nan in any case; then rounded to f32.
 */
function parseF32(s: string): number | undefined {
  if (/^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return f32(Number(s));
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
  if (!m) return undefined;
  if (m[2]!.toLowerCase() === "nan") return NaN;
  return m[1] === "-" ? -Infinity : Infinity;
}

/** Rust's `{}` for an f32: the shortest digits that round-trip as f32, never in exponent form. */
function formatF32(v: number): string {
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  let exp = "";
  for (let p = 1; p <= 9; p++) {
    exp = v.toExponential(p - 1);
    if (f32(Number(exp)) === v) break;
  }
  const [mant, e] = exp.split("e") as [string, string];
  const neg = mant.startsWith("-");
  const digits = mant.replace(/^-/, "").replace(".", "");
  const point = Number(e) + 1;
  let s: string;
  if (point <= 0) s = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) s = digits + "0".repeat(point - digits.length);
  else s = digits.slice(0, point) + "." + digits.slice(point);
  return (neg ? "-" : "") + s;
}

async function fail(ctx: CommandCtx, msg: string) {
  await err(ctx, msg);
  return 1;
}

export const seq: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) return fail(ctx, USAGE);
  let separator = "\n";
  let terminator = "";
  let idx = 0;
  for (; idx < args.length; idx++) {
    const arg = args[idx]!;
    if (arg === "-s" || arg === "--separator") {
      if (++idx >= args.length) return fail(ctx, "seq: option requires an argument -- s\n");
      separator = args[idx]!;
    } else if (arg.startsWith("-s") && arg.length > 2) separator = arg.slice(2);
    else if (arg === "-t" || arg === "--terminator") {
      if (++idx >= args.length) return fail(ctx, "seq: option requires an argument -- t\n");
      terminator = args[idx]!;
    } else if (arg.startsWith("-t") && arg.length > 2) terminator = arg.slice(2);
    else if (arg !== "-w" && arg !== "--fixed-width") break;
  }

  const nums: number[] = [];
  for (const a of args.slice(idx, idx + 3)) {
    const n = parseF32(a);
    if (n === undefined || !Number.isFinite(n)) return fail(ctx, "seq: invalid argument\n");
    nums.push(n);
  }
  if (!nums.length) return fail(ctx, USAGE);
  let start = 1;
  let end = nums[0]!;
  let incr = start > end ? -1 : 1;
  if (nums.length === 2) {
    [start, end] = nums as [number, number];
    incr = start < end ? 1 : start > end ? -1 : incr;
  } else if (nums.length === 3) {
    [start, incr, end] = nums as [number, number, number];
    if (incr === 0) return fail(ctx, "seq: zero increment\n");
    if (start > end && incr > 0) return fail(ctx, "seq: needs negative decrement\n");
    if (start < end && incr < 0) return fail(ctx, "seq: needs positive increment\n");
  }

  const parts: string[] = [];
  for (let cur = start; incr > 0 ? cur <= end : cur >= end; ) {
    parts.push(formatF32(cur), separator);
    const next = f32(cur + incr);
    // f32 rounding can leave `cur + incr` at `cur` (past 2^24, or a tiny increment): stop rather than loop forever.
    if (next === cur) break;
    cur = next;
  }
  parts.push(terminator);
  await out(ctx, parts.join(""));
  return 0;
};
