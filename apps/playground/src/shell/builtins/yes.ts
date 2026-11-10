// `yes`: bun/src/runtime/shell/builtin/yes.rs
import type { Command } from "../interp";
import { out } from "./util";

const BUFSIZ = 8192;
const enc = new TextEncoder();

export const yes: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  const one = enc.encode(args.length ? args.join(" ") + "\n" : "y\n");
  // Tiled to at least BUFSIZ: one write per 8 KiB rather than per line.
  const size = one.length <= BUFSIZ / 2 ? BUFSIZ : one.length;
  const copies = Math.floor(size / one.length);
  const chunk = new Uint8Array(copies * one.length);
  for (let i = 0; i < copies; i++) chunk.set(one, i * one.length);

  for (;;) {
    // Four chunks, then a turn of the event loop, so `yes` into something that never fills can't freeze the page.
    for (let i = 0; i < 4; i++) {
      if (ctx.signal.aborted) return 130;
      if (!(await out(ctx, chunk))) {
        // A full buffer (`yes > ${buf}`) is an error Bun reports; a closed pipe (`yes | head`) isn't.
        if (ctx.stdout.error) await ctx.stderr.write(`yes: ${ctx.stdout.error}\n`);
        return 1;
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
};
