// What keeps a program running, as Bun's event loop counts it: timers, servers, sockets and the playground's own
// pending promises (fetch, Bun.sleep, file reads; see promises.ts `tracked`) hold the program while they are alive.
// When nothing does, the program has run out of work and ends (runtime.ts `drained`): `beforeExit`, then `exit`.
//
// The browser's own async APIs the program calls directly (crypto.subtle, WebAssembly.instantiate, a literal
// `import()`) aren't counted. So the program counts as idle only after nothing has held it for IDLE_FOR: what those
// settle and start meanwhile (a timer, a fetch) holds it again.

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

/** A timer that doesn't hold the program: for the playground's own housekeeping (a write-back, an idle thread). */
export const quietTimeout = (fn: () => void, ms: number) => nativeSetTimeout(fn, ms);

/** How long the program must hold nothing before it counts as idle. */
const IDLE_FOR = 50;

const holds = new Set<object>();
/** Bumped whenever something takes a hold: an idle check that sees it change started over. */
let generation = 0;
let onIdle: (() => void) | undefined;
let check: ReturnType<typeof setTimeout> | undefined;

/** `h` keeps the program running until `release(h)`. Holding twice is holding once. */
export function hold(h: object) {
  if (holds.has(h)) return;
  holds.add(h);
  generation++;
}

export function release(h: object) {
  if (holds.delete(h) && !holds.size) schedule();
}

export const held = (h: object) => holds.has(h);

/** `p`, holding the program until it settles. */
export function holdUntil<T>(p: Promise<T>): Promise<T> {
  const h = {};
  hold(h);
  const done = () => release(h);
  Promise.prototype.then.call(p, done, done);
  return p;
}

/** Something happened that could have started work: the program counts as idle only after another IDLE_FOR. */
export const touch = () => void generation++;

/** The current generation; `whenIdle`'s callback compares it to see whether `beforeExit` listeners started work. */
export const currentGeneration = () => generation;

/** Calls `cb` each time the program runs out of work, from now on. */
export function whenIdle(cb: () => void) {
  onIdle = cb;
  schedule();
}

function schedule() {
  if (!onIdle) return;
  if (check !== undefined) nativeClearTimeout(check);
  const seen = generation;
  check = nativeSetTimeout(() => {
    check = undefined;
    if (holds.size) return; // whatever holds it schedules the next check when it lets go
    if (generation !== seen) return schedule();
    onIdle?.();
  }, IDLE_FOR);
}
