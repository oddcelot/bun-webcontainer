/**
 * The step debugger's page side: whether runs are debug runs, the breakpoints (per project path, 0-based lines), and
 * the paused state of the running program, with the commands that resume or step it (debugProtocol.ts). The runner
 * attaches each debug run's worker (`attach`) and routes its `dbg-*` messages here; the module server instruments a
 * debug run's project files (`instrumenting`).
 *
 * Needs cross-origin isolation (the paused worker blocks on a SharedArrayBuffer) and the worker in this page's agent
 * cluster: not on the content origin, whose host frame owns the worker (`debugAvailable`).
 */
import { createSignal } from "solid-js";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { CTL_INTS, DEBUG_BUFFER_BYTES, type DebugCommand, type DebugPaused, sendCommand } from "./debugProtocol";

export type { DebugFrame, DebugPaused, DebugScope } from "./debugProtocol";

const STORE_KEY = "bwc:breakpoints";

export const debugAvailable = (): boolean => typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true && !CONTENT_ORIGIN;

function loadBreakpoints(): Record<string, number[]> {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as Record<string, number[]>;
  } catch {
    return {};
  }
}

const [enabled, setEnabledSignal] = createSignal(false);
// The signal is for showing them: Solid 2 batches writes, so a read right after one (two quick toggles) is stale.
let breakpointState = loadBreakpoints();
const [breakpoints, setBreakpointsSignal] = createSignal<Record<string, number[]>>(breakpointState);
const [paused, setPaused] = createSignal<DebugPaused | undefined>(undefined);
const [attached, setAttached] = createSignal(false);

let current: { worker: Worker; sab: SharedArrayBuffer } | undefined;
let evalId = 0;
const evaluations = new Map<number, (r: { ok: boolean; result: string }) => void>();

/** Commands for the paused worker, in order: the buffer holds one until the worker takes it. */
const queue: DebugCommand[] = [];

function pump() {
  const run = current;
  while (run && queue.length && sendCommand(run.sab, queue[0])) queue.shift();
  // Commands are few (a click each): polling until the worker takes the last one is enough.
  if (run && queue.length) setTimeout(pump, 5);
}

function send(cmd: DebugCommand): boolean {
  if (!current) return false;
  if (paused()) {
    queue.push(cmd);
    pump();
  } else if (cmd.type === "breakpoints") current.worker.postMessage({ type: "dbg-breakpoints", breakpoints: cmd.breakpoints });
  return true;
}

function setBreakpoints(next: Record<string, number[]>) {
  breakpointState = next;
  setBreakpointsSignal(next);
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: breakpoints last until reload
  }
  send({ type: "breakpoints", breakpoints: next });
}

export const debugSession = {
  available: debugAvailable,
  /** Runs started while on are debug runs. */
  enabled,
  setEnabled(on: boolean) {
    setEnabledSignal(on && debugAvailable());
  },
  /** A debug run's worker is running (or paused). */
  attached,
  breakpoints,
  /** The 0-based lines with a breakpoint in `path`. */
  linesOf(path: string): number[] {
    return breakpoints()[path] ?? [];
  },
  toggleBreakpoint(path: string, line: number) {
    const all = { ...breakpointState };
    const lines = new Set(all[path] ?? []);
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    if (lines.size) all[path] = [...lines].sort((a, b) => a - b);
    else delete all[path];
    setBreakpoints(all);
  },
  clearBreakpoints() {
    setBreakpoints({});
  },
  paused,
  resume: () => send({ type: "resume" }),
  stepOver: () => send({ type: "over" }),
  stepInto: () => send({ type: "into" }),
  stepOut: () => send({ type: "out" }),
  /** Evaluates `expression` in the paused frame (its locals in scope), as a preview string. */
  evaluate(expression: string): Promise<{ ok: boolean; result: string }> {
    if (!paused()) return Promise.resolve({ ok: false, result: "Not paused" });
    const id = ++evalId;
    return new Promise((resolve) => {
      evaluations.set(id, resolve);
      if (!send({ type: "evaluate", id, expression })) {
        evaluations.delete(id);
        resolve({ ok: false, result: "The debugger is busy" });
      }
    });
  },
};

/** Whether the module server should instrument the files it serves now: a debug run is starting or running. */
export function instrumenting(): boolean {
  return current !== undefined;
}

/** For the runner: a new run's worker; what its start message carries if it's a debug run. */
export function attach(worker: Worker): { sab: SharedArrayBuffer; breakpoints: Record<string, number[]> } | undefined {
  if (!enabled() || !debugAvailable()) return undefined;
  const sab = new SharedArrayBuffer(CTL_INTS * 4 + DEBUG_BUFFER_BYTES);
  current = { worker, sab };
  setPaused(undefined);
  setAttached(true);
  return { sab, breakpoints: breakpointState };
}

/** For the runner: `worker` ended. */
export function detach(worker: Worker) {
  if (current?.worker !== worker) return;
  current = undefined;
  queue.length = 0;
  setPaused(undefined);
  setAttached(false);
  for (const resolve of evaluations.values()) resolve({ ok: false, result: "The program ended" });
  evaluations.clear();
}

/** For the runner: a `dbg-*` message from `worker`. */
export function onDebugMessage(worker: Worker, m: { type: string; [k: string]: any }) {
  if (current?.worker !== worker) return;
  if (m.type === "dbg-paused") {
    const { type: _, ...state } = m;
    setPaused(state as DebugPaused);
  } else if (m.type === "dbg-resumed") setPaused(undefined);
  else if (m.type === "dbg-evaluated") {
    evaluations.get(m.id)?.({ ok: m.ok, result: m.result });
    evaluations.delete(m.id);
  }
}
