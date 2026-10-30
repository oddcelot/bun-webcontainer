import { action, createOptimistic, createOptimisticStore, createSignal, createStore, flush } from "solid-js";

export type Status = { state: "idle" | "busy" | "running" | "error"; text: string };
export type Task = "run" | "install";

/** What the header shows about the program: create it inside a root (main.ts) and pass it to the UI. */
export function createSession(canRun: boolean) {
  // Startup runs the project when the browser can, so say so from the first frame instead of "Stopped".
  const [status, setStatus] = createSignal<Status>(canRun ? { state: "busy", text: "Starting…" } : { state: "idle", text: "Stopped" });
  // While a task is in flight these show "Starting…" and a disabled button; both revert when it settles.
  const [shown, setShown] = createOptimistic(() => status());
  const [busy, setBusy] = createOptimisticStore<Partial<Record<Task, boolean>>>({});
  const [ready, setReady] = createSignal(false);
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => (resolveStarted = r));
  const [counts, setCounts] = createStore({ lines: 0, error: 0, warn: 0 });
  const [project, setProject] = createSignal<{ selected: string; extra: [label: string, value: string][]; reopen?: string }>({ selected: "", extra: [] });

  // Writes made in the action's frame are held until it settles, so `work` starts after that frame is flushed:
  // what it writes along the way (console counts, say) shows as it happens. Only the busy state and the end
  // status ride the action.
  const settle = action(function* (kind: Task, text: string, work: Promise<Status | void>) {
    setBusy((b) => {
      b[kind] = true;
    });
    setShown({ state: "busy", text });
    const next: Status | void = yield work;
    if (next) setStatus(next);
  });
  /** Runs `work` with `kind`'s button disabled and `text` as the status; `work` returns the status to settle on, or nothing to keep the current one. */
  const task = (kind: Task, text: string, work: () => Promise<Status | void>) => {
    let start!: (work: Promise<Status | void>) => void;
    // Commit what the caller wrote just before (startup's ready flag and opened file), or the action holds it too.
    flush();
    const done = settle(kind, text, new Promise((r) => (start = r)));
    flush();
    start(work());
    return done;
  };

  return {
    canRun,
    /** The status as shown, busy text included. */
    status: shown,
    /** The status a task settled on (or `setStatus` set). */
    settled: status,
    setStatus,
    busy,
    task,
    /** False until main.ts has set up the runner and loaded the project. */
    ready,
    /** Resolves once ready: actions clicked during startup wait for it instead of disabling their buttons. */
    started,
    markReady() {
      setReady(true);
      resolveStarted();
    },
    /** Console lines, and how many of them are errors and warnings. */
    counts,
    countLine(level: string) {
      setCounts((c) => {
        c.lines++;
        if (level === "error" || level === "warn") c[level]++;
      });
    },
    resetCounts() {
      setCounts((c) => {
        c.lines = c.error = c.warn = 0;
      });
    },
    /** The project picker: which entry is selected, plus entries for the loaded repo or shared project. */
    project,
    setProject,
  };
}

export type Session = ReturnType<typeof createSession>;
