/**
 * What the step debugger's page side (debugSession.ts) and worker side (worker/debugger.ts) share: the probe table the
 * transpiler writes (`DEBUG`), the paused state the worker reports, and the commands the page writes into the shared
 * buffer for a paused worker: an Int32 header (`CTL`) and the command as JSON after it.
 */

/** Per probe: line, column (0-based, UTF-16), scope, and 1 for a `debugger` statement. */
export type Probe = [line: number, column: number, scope: number, debuggerStatement?: 1];
/** Per scope: parent (-1 for none), kind (0 module, 1 function, 2 block), the names it declares. */
export type ProbeTable = { file: number; probes: Probe[]; scopes: [parent: number, kind: number, names: string[]][] };

export type DebugFrame = { name: string; path: string; line: number; column: number; async: boolean };
export type DebugScope = { kind: "module" | "local" | "block"; vars: { name: string; value: string }[] };
export type DebugPaused = {
  reason: "breakpoint" | "step" | "debugger";
  /** Project path (no leading slash), 0-based line and column of the statement about to run. */
  path: string;
  line: number;
  column: number;
  frames: DebugFrame[];
  /** The paused frame's scopes, innermost first. */
  scopes: DebugScope[];
};

export type DebugCommand =
  | { type: "resume" | "into" | "over" | "out" }
  | { type: "evaluate"; id: number; expression: string }
  | { type: "breakpoints"; breakpoints: Record<string, number[]> };

/** Header slots: STATE 1 while a command waits for the worker, LENGTH its bytes. */
export const CTL = { STATE: 0, LENGTH: 1 } as const;
export const CTL_INTS = 2;
export const DEBUG_BUFFER_BYTES = 64 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Writes `cmd` for the worker and wakes it; false if the last command wasn't taken yet or it doesn't fit. */
export function sendCommand(sab: SharedArrayBuffer, cmd: DebugCommand): boolean {
  const ctl = new Int32Array(sab, 0, CTL_INTS);
  if (Atomics.load(ctl, CTL.STATE) !== 0) return false;
  const bytes = enc.encode(JSON.stringify(cmd));
  const data = new Uint8Array(sab, CTL_INTS * 4);
  if (bytes.length > data.length) return false;
  data.set(bytes);
  Atomics.store(ctl, CTL.LENGTH, bytes.length);
  Atomics.store(ctl, CTL.STATE, 1);
  Atomics.notify(ctl, CTL.STATE);
  return true;
}

export function decodeCommand(data: Uint8Array, length: number): DebugCommand {
  // TextDecoder refuses views of shared memory.
  return JSON.parse(dec.decode(data.slice(0, length))) as DebugCommand;
}

/**
 * Commands for a paused worker, in order: the buffer holds one until the worker takes it. Where the buffer is: the
 * page's, or on the content origin the host frame's (host/main.ts), which gets the page's commands as messages.
 */
export class CommandQueue {
  private queue: DebugCommand[] = [];
  constructor(private sab: SharedArrayBuffer) {}
  push(cmd: DebugCommand) {
    this.queue.push(cmd);
    this.pump();
  }
  clear() {
    this.queue.length = 0;
  }
  private pump = () => {
    while (this.queue.length && sendCommand(this.sab, this.queue[0])) this.queue.shift();
    // Commands are few (a click each): polling until the worker takes the last one is enough.
    if (this.queue.length) setTimeout(this.pump, 5);
  };
}

/** The start message's `debug`: the page's buffer, or (`host`) one the host frame makes and puts in its place. */
export type DebugStart = { sab?: SharedArrayBuffer; host?: true; breakpoints: Record<string, number[]> };
