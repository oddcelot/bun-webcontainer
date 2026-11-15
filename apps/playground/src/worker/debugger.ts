/**
 * The step debugger's worker side. A debug run's project files are instrumented by the transpiler (`DEBUG`, see
 * crates/transpile-wasm/src/debug.rs): each module registers its probe table (`__dbg.file`), and before each statement
 * asks `__dbg(file, probe)`. When a breakpoint or a step wants that statement, the worker posts what the
 * page shows (`dbg-paused`: frames, scopes) and blocks in `Atomics.wait` until the page writes a command into the
 * shared buffer (debugProtocol.ts): resume or step, or evaluate in the paused frame, or new breakpoints.
 * Blocking needs cross-origin isolation (a SharedArrayBuffer); the runner only starts a debug run with it.
 */
import { CTL, CTL_INTS, decodeCommand, type DebugCommand, type DebugFrame, type DebugScope, type Probe, type ProbeTable } from "../debugProtocol";
import { formatCell } from "./inspect";
import { type CallSite, CJS_WRAPPER, mapLocation } from "./sourceMaps";

type File = { path: string; table: ProbeTable; bp: Uint8Array };
type Step = "into" | "over" | "out";

const KIND = ["module", "local", "block"] as const;

/** Installs `globalThis.__dbg` for a debug run. `post` sends to the page; `root` is the served modules' URL root. */
export function installDebugger(sab: SharedArrayBuffer, breakpoints: Record<string, number[]>, post: (m: unknown) => void, root: () => string) {
  const ctl = new Int32Array(sab, 0, CTL_INTS);
  const data = new Uint8Array(sab, CTL_INTS * 4);
  const files = new Map<number, File>();
  let lines = breakpoints;
  let breakpointCount = 0;
  let step: Step | undefined;
  let stepDepth = 0;
  let pausing = false;

  function mark(f: File) {
    f.bp.fill(0);
    const want = new Set(lines[f.path] ?? []);
    // The first probe on a line stands for it: a line with several statements pauses once.
    const seen = new Set<number>();
    f.table.probes.forEach((p: Probe, id) => {
      if (seen.has(p[0])) return;
      seen.add(p[0]);
      if (want.has(p[0])) f.bp[id] = 1;
    });
  }
  function setBreakpoints(next: Record<string, number[]>) {
    lines = next;
    breakpointCount = Object.values(next).reduce((n, l) => n + l.length, 0);
    for (const f of files.values()) mark(f);
  }
  setBreakpoints(breakpoints);

  /** The call sites above `__dbg`, as V8 has them. */
  function callSites(): CallSite[] {
    const prepare = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    Error.prepareStackTrace = (_e, sites) => sites;
    Error.stackTraceLimit = Infinity;
    try {
      const sites = new Error().stack as unknown as CallSite[];
      return sites.slice(2); // callSites, __dbg
    } finally {
      Error.prepareStackTrace = prepare;
      Error.stackTraceLimit = limit;
    }
  }

  function frames(sites: CallSite[]): DebugFrame[] {
    const out: DebugFrame[] = [];
    for (const s of sites) {
      // Code run with `new Function` (a require()d file) has its sourceURL, not a file name.
      const url = s.getFileName() ?? s.getScriptNameOrSourceURL?.();
      if (!url) continue;
      const loc = mapLocation(root(), url, s.getLineNumber() ?? 0, s.getColumnNumber() ?? 0);
      if (!loc) continue; // the worker's own code
      const name = s.getFunctionName();
      // Wrapped CommonJS's own functions around a file's body.
      if (!loc.mapped && name && CJS_WRAPPER.has(name)) continue;
      out.push({ name: name || "", path: loc.path.replace(/^\//, ""), line: loc.line - 1, column: loc.column - 1, async: s.isAsync() });
    }
    return out;
  }

  const preview = (v: unknown) => {
    try {
      const s = formatCell(v, 3);
      return s.length > 300 ? s.slice(0, 299) + "…" : s;
    } catch (e) {
      return `<${e instanceof Error ? e.message : String(e)}>`;
    }
  };

  function scopes(f: File, probe: Probe, scopedEval: (n: string) => unknown): DebugScope[] {
    const out: DebugScope[] = [];
    for (let s = probe[2]; s >= 0; s = f.table.scopes[s][0]) {
      const [, kind, names] = f.table.scopes[s];
      out.push({
        kind: KIND[kind],
        vars: names.map((name) => {
          try {
            return { name, value: preview(scopedEval(name)) };
          } catch {
            return { name, value: "<uninitialized>" };
          }
        }),
      });
    }
    return out;
  }

  /** Blocks until the page sends a command; returns the next one. */
  function waitCommand(): DebugCommand {
    Atomics.wait(ctl, CTL.STATE, 0);
    const cmd = decodeCommand(data, Atomics.load(ctl, CTL.LENGTH));
    Atomics.store(ctl, CTL.STATE, 0);
    return cmd;
  }

  function pause(f: File, id: number, scopedEval: (n: string) => unknown, reason: "breakpoint" | "step" | "debugger", sites: CallSite[]) {
    const probe = f.table.probes[id];
    pausing = true;
    try {
      const stack = frames(sites);
      // The probe's call has no source-map segment of its own: the top frame is where the probe says.
      if (stack[0]) Object.assign(stack[0], { path: f.path, line: probe[0], column: probe[1] });
      post({ type: "dbg-paused", reason, path: f.path, line: probe[0], column: probe[1], frames: stack, scopes: scopes(f, probe, scopedEval) });
      for (;;) {
        const cmd = waitCommand();
        if (cmd.type === "breakpoints") setBreakpoints(cmd.breakpoints);
        else if (cmd.type === "evaluate") {
          let result: string, ok = true;
          try {
            result = preview(scopedEval(cmd.expression));
          } catch (e) {
            ok = false;
            result = e instanceof Error ? `${e.name}: ${e.message}` : preview(e);
          }
          post({ type: "dbg-evaluated", id: cmd.id, ok, result });
        } else {
          step = cmd.type === "resume" ? undefined : cmd.type;
          stepDepth = sites.length;
          post({ type: "dbg-resumed" });
          return;
        }
      }
    } finally {
      pausing = false;
    }
  }

  // `__dbg(file, id)` says whether to pause at that statement; if so, the statement calls `__dbg.p` with an arrow that
  // evaluates in its scope (see src/debug.rs), right after.
  let pending: { f: File; id: number; reason: "breakpoint" | "step" | "debugger"; sites: CallSite[] } | undefined;
  const want = (f: File, id: number, reason: "breakpoint" | "step" | "debugger", sites: CallSite[]) => {
    pending = { f, id, reason, sites };
    return true;
  };
  const dbg = (file: number, id: number, debuggerStatement?: 1): boolean => {
    if (pausing || (!step && !breakpointCount && !debuggerStatement)) return false;
    const f = files.get(file);
    if (!f) return false;
    if (debuggerStatement || f.bp[id]) return want(f, id, debuggerStatement ? "debugger" : "breakpoint", callSites());
    if (!step) return false;
    const sites = callSites();
    const depth = sites.length;
    if (step === "into" || (step === "over" && depth <= stepDepth) || (step === "out" && depth < stepDepth)) return want(f, id, "step", sites);
    return false;
  };
  dbg.p = (scopedEval: (n: string) => unknown) => {
    const p = pending;
    pending = undefined;
    if (p) pause(p.f, p.id, scopedEval, p.reason, p.sites);
  };
  /** Read by worker/node/module.ts: what it transpiles itself is instrumented too. */
  dbg.active = true;
  dbg.file = (file: number, path: string, table: ProbeTable) => {
    const f: File = { path, table, bp: new Uint8Array(table.probes.length) };
    files.set(file, f);
    mark(f);
  };
  Object.defineProperty(globalThis, "__dbg", { value: dbg, configurable: true });

  // While running, breakpoints come as messages; while paused, through the buffer (waitCommand).
  self.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "dbg-breakpoints") setBreakpoints(e.data.breakpoints);
  });
}

/** A `__dbg` that never pauses, for a process that isn't a debug run. */
export function installNoopDebugger() {
  const dbg = () => false;
  dbg.file = () => {};
  dbg.p = () => {};
  Object.defineProperty(globalThis, "__dbg", { value: dbg, configurable: true });
}
