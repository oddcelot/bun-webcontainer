// `export`: bun/src/runtime/shell/builtin/export.rs
import type { Command } from "../interp";
import { out } from "./util";

export const export_: Command = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) {
    // Sorted by bytes, as Bun compares the names' slices.
    const enc = new TextEncoder();
    const cmp = (a: string, b: string) => {
      const x = enc.encode(a);
      const y = enc.encode(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
      return x.length - y.length;
    };
    const entries = [...ctx.shell.exported].sort(([a], [b]) => cmp(a, b));
    await out(ctx, entries.map(([k, v]) => `${k}=${v}\n`).join(""));
    return 0;
  }
  for (const s of args) {
    if (!s) continue;
    const eq = s.indexOf("=");
    // `export NAME` without `=` exports it as empty, whatever the shell variable holds.
    if (eq < 0) ctx.shell.exported.set(s, "");
    else ctx.shell.exported.set(s.slice(0, eq), s.slice(eq + 1));
  }
  return 0;
};
