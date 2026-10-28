import { action, createOptimistic, createOptimisticStore, createSignal } from "solid-js";

export type Status = { state: "idle" | "busy" | "running" | "error"; text: string };
export type Task = "run" | "install";

/** What the header shows about the program: create it inside a root (main.ts) and pass it to the UI. */
export function createSession(canRun: boolean) {
  const [status, setStatus] = createSignal<Status>({ state: "idle", text: "Stopped" });
  // While a task is in flight these show "Starting…" and a disabled button; both revert when it settles.
  const [shown, setShown] = createOptimistic(() => status());
  const [busy, setBusy] = createOptimisticStore<Partial<Record<Task, boolean>>>({});
  const [ready, setReady] = createSignal(false);
  const [project, setProject] = createSignal({ selected: "", extra: [] as [label: string, value: string][] });

  /** Runs `work` with `kind`'s button disabled and `text` as the status; `work` returns the status to settle on, or nothing to keep the current one. */
  const task = action(function* (kind: Task, text: string, work: () => Promise<Status | void>) {
    setBusy((b) => {
      b[kind] = true;
    });
    setShown({ state: "busy", text });
    const next: Status | void = yield work();
    if (next) setStatus(next);
  });

  return {
    canRun,
    /** The status as shown, busy text included. */
    status: shown,
    /** The status a task settled on (or `setStatus` set). */
    settled: status,
    setStatus,
    busy,
    task,
    /** False until main.ts has wired the runner, tabs and file tree; buttons that need them stay disabled. */
    ready,
    setReady,
    /** The project picker: which entry is selected, plus entries for the loaded repo or shared project. */
    project,
    setProject,
  };
}

export type Session = ReturnType<typeof createSession>;
