import { createEffect, createRoot } from "solid-js";
import { BASE } from "./base";
import { createConsole } from "./console";
import { CHECKED, diagnose } from "./diagnostics";
import { attachStore } from "./pkgStore";
import { bunInstall } from "./install";
import { Runner } from "./runner";
import { RemoteRunner } from "./remoteRunner";
import type { LocalBun } from "./localBun";
import { setVfsOwner } from "./moduleServer";
import { setPreviewOwner } from "./preview";
import { loadSemver, type Semver } from "./semver";
import { commandOf, createShell, entryOf, type Command } from "./shell";
import { checkSupport } from "./support";
import { createPreviews } from "./ui/previews";
import { createSession, type Status } from "./ui/session";
import { createWorkspace } from "./ui/workspace";
import { VFS } from "@runbun/vfs";

/**
 * The engine both pages share (index.html's full playground and embed.html): the VFS, the console, the session the UI
 * reads, and Run, Install, Test and Stop. Loading a project is the page's job; `start` then brings up the service
 * worker and the runner. `watch` says whether a save restarts the program (default: the workspace's Restart on save).
 */
/** A console path as the VFS keys it: `/index.ts` and `./index.ts` are `index.ts`. */
const bare = (path: string) => path.replace(/^\.?\//, "");

export function createPlayground({ watch, local }: { watch?: () => boolean; local?: LocalBun } = {}) {
  const support = checkSupport();
  /**
   * False when a requirement is missing: the interface still loads, but nothing that runs code starts. With native
   * Bun on this machine (`local`, see localBun.ts) the program runs there, so the browser needs no WebAssembly.
   */
  const canRun = support.every((c) => c.ok || (!!local && c.name.startsWith("WebAssembly")));
  const logListeners = new Set<(level: string, text: string) => void>();
  // The shell (see `start`) needs the runner, which comes later.
  let exec: (line: string) => Promise<void> = async () => {};
  const terminal = createConsole({
    onCommand: (line) => exec(line),
    onInterrupt: () => stop(),
    onClear: () => clearConsole(),
    isFile: (path) => vfs.files.has(bare(path)),
    onLocation: (path, line, column) => workspace.openAt(bare(path), line, column),
  });
  const [session, workspace, previews] = createRoot(() => {
    const session = createSession(canRun);
    return [session, createWorkspace(), createPreviews(() => session.settled().state === "running", (path) => vfs.readBytes(path))] as const;
  });
  const vfs = new VFS();
  attachStore(vfs);
  let runner: Runner | RemoteRunner | undefined;
  let semver: Semver | undefined;

  function log(level: string, text: string) {
    terminal.log(level, text);
    session.countLine(level);
    for (const fn of logListeners) fn(level, text);
  }
  const cantRun = () => log("error", "this browser can't run code here; see the banner above the editor");

  async function setupServiceWorker() {
    const reg = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
    await reg.update().catch(() => {});
    const updating = reg.installing ?? reg.waiting;
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller || updating) {
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    if (!navigator.serviceWorker.controller) return log("error", "service worker is not controlling this page; reload without hard-refresh");
    // Which client this page is to the worker: module URLs carry it, so the worker asks this page for its files.
    const ch = new MessageChannel();
    const answer = new Promise<string>((r) => (ch.port1.onmessage = (e) => r(e.data)));
    navigator.serviceWorker.controller.postMessage({ type: "whoami" }, [ch.port2]);
    const id = await Promise.race([answer, new Promise<undefined>((r) => setTimeout(r, 3000))]);
    if (id) {
      setVfsOwner(id);
      setPreviewOwner(id);
    }
    // What loaded before the worker took over (a first visit) goes into its cache too, for the next visit and offline.
    const urls = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)];
    navigator.serviceWorker.controller.postMessage({ type: "adopt-shell", urls });
  }

  /** The file to open first (see `entryOf`). */
  function entryFile(): string {
    return entryOf((path) => vfs.files.has(path), (path) => vfs.readText(path));
  }

  /** What Run starts (see `commandOf`). */
  function command(): Command {
    return commandOf((path) => vfs.files.has(path), (path) => vfs.readText(path));
  }

  /** What the last Run started, to start it again after `bun test` (which replaces the server) or a save. */
  let lastEntry: string | undefined;
  let lastArgs: string[] = [];

  async function run(entry?: string, args: string[] = []) {
    if (entry === undefined) ({ entry, args } = command());
    if (!runner) return cantRun();
    workspace.saveAll();
    await session.task("run", "Starting…", async (): Promise<Status> => {
      log("sys", `[run] ${[entry, ...args].join(" ")}`);
      lastEntry = entry;
      lastArgs = args;
      try {
        await runner!.start(entry!, undefined, args);
        if (runner!.exitCode !== undefined) return exited(runner!.exitCode);
        previews.reload();
        return { state: "running", text: `Running ${entry}` };
      } catch (e) {
        log("error", String(e));
        return { state: "error", text: "Failed to start" };
      }
    });
  }

  async function install() {
    if (runner instanceof RemoteRunner) {
      workspace.saveAll();
      const remote = runner;
      await session.task("install", "Installing…", async () => {
        log("sys", "[bun install]");
        await remote.install();
      });
      return;
    }
    if (!semver) return cantRun();
    workspace.saveAll();
    // A running server keeps running through an install, so the status goes back to what it was.
    await session.task("install", "Installing…", async () => {
      log("sys", "[bun install]");
      try {
        const n = await bunInstall(vfs, semver!, log);
        log("sys", `[bun install] ${n} packages installed`);
      } catch (e) {
        log("error", String(e));
      }
    });
  }

  /** `bun test`: a fresh worker runs the files; a server that was running is started again afterwards. */
  async function test(files: string[]): Promise<number> {
    if (!runner) return cantRun(), 0;
    workspace.saveAll();
    const wasRunning = session.settled().state === "running";
    let failed = 0;
    await session.task("run", "Testing…", async (): Promise<Status> => {
      failed = await runner!.runTests(files);
      return failed ? { state: "error", text: `${failed} test${failed === 1 ? "" : "s"} failed` } : { state: "idle", text: "Tests passed" };
    });
    if (wasRunning) await run(lastEntry, lastArgs);
    return failed;
  }

  /** The program ended itself (process.exit, an uncaught error): the console and status say with which code. */
  function exited(code: number): Status {
    log("sys", `[exited with code ${code}]`);
    if (!code) return { state: "idle", text: "Exited" };
    // A crash doesn't end watching (see below): the status says a save is enough.
    return { state: "error", text: watching && watchOn() ? `Exited with code ${code} · reruns on save` : `Exited with code ${code}` };
  }

  function stop() {
    if (session.settled().state !== "running") return;
    void runner?.stop();
    log("sys", "[stopped]");
    session.setStatus({ state: "idle", text: "Stopped" });
  }

  function clearConsole() {
    terminal.clear();
    session.resetCounts();
  }

  /** Clears the project (after stopping the program) to load another into the VFS. */
  async function clearProject() {
    await session.started;
    // Finished before the clear: a database flushed afterwards would land in the next project.
    await runner?.stop();
    workspace.closeAll();
    vfs.clear();
  }

  async function newFile(path: string) {
    await session.started;
    vfs.write(path, "");
    workspace.open(path);
  }

  /** Like StackBlitz: install on load when a dependency is missing from node_modules. */
  function missingDeps(): boolean {
    try {
      const pkg = JSON.parse(vfs.readText("package.json") ?? "{}") as { dependencies?: Record<string, string> };
      return Object.keys(pkg.dependencies ?? {}).some((n) => !vfs.files.has(`node_modules/${n}/package.json`));
    } catch {
      return false;
    }
  }

  vfs.onChange(({ path, removed }) => {
    if (removed) workspace.close(path);
  });

  // --- Restart on save, like `bun --watch`
  // A save the reader made while the program is watched starts it again. Only the editor's saves count (not the
  // program's own writes, an install or Run's save first); a burst is one restart, and one that lands while a run,
  // test or install is under way waits for it. Running arms it; a crash keeps it (the next save runs the program
  // again), Stop and a clean exit end it. A save that leaves an open file unparsable (half-typed, as auto-save
  // saves) keeps the program as it is and waits for one that parses. Each restart clears the console, as Bun does.
  const watchOn = watch ?? (() => workspace.watch());
  const WATCH_DELAY = 300;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watching = false;
  let waitingFor: string | undefined;
  createRoot(() => {
    createEffect(
      () => session.settled().state,
      (state) => {
        if (state === "running") watching = true;
        else if (state === "idle") watching = false;
      },
    );
    // Any run that starts (Run, the API, a restart) saves first, so a restart still pending would only run it twice.
    createEffect(
      () => !!session.busy.run,
      (busy) => {
        if (busy) clearTimeout(watchTimer);
      },
    );
  });
  /** The first open file that doesn't parse, as `path:line:column`, and its first error. */
  async function unparsable(): Promise<[at: string, message: string] | undefined> {
    for (const path of workspace.state.open) {
      const text = CHECKED.test(path) ? vfs.readText(path) : undefined;
      if (text === undefined) continue;
      const error = (await diagnose(vfs, path, text, false)).find((d) => d.severity === "error");
      if (error) return [`${path}:${error.line}:${error.column}`, error.message];
    }
  }
  async function restart() {
    if (!watchOn() || !watching) return;
    if (session.busy.run || session.busy.install) return void (watchTimer = setTimeout(restart, WATCH_DELAY));
    const broken = await unparsable();
    if (broken) {
      const [at, message] = broken;
      if (at !== waitingFor) log("sys", `[watch] waiting for a save that parses: ${at}: ${message}`);
      waitingFor = at;
      session.setStatus({ state: session.settled().state, text: `Syntax error in ${at} · waiting for a fix` });
      return;
    }
    waitingFor = undefined;
    clearConsole();
    log("sys", "[watch] restarting");
    void run(lastEntry, lastArgs);
  }
  workspace.onSaved(() => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(restart, WATCH_DELAY);
  });


  /** Brings up the service worker, semver and the runner (when the browser can run code) and the console's shell. */
  async function start({ reset }: { reset(): Promise<void> }) {
    if (canRun) {
      await setupServiceWorker();
      if (local) {
        runner = new RemoteRunner(vfs, log, local);
        log("sys", `[local] runs go to Bun ${local.bun} on this machine (sandbox: ${local.sandbox})`);
      } else {
        semver = await loadSemver();
        runner = new Runner(vfs, log);
      }
      runner.onExit = (code) => session.setStatus(exited(code));
    }
    exec = createShell({ vfs, log, run, install, test, stop, clear: clearConsole, reset, cookies: runner && { list: () => runner!.listCookies(), clear: () => runner!.clearCookies() } });
    session.markReady();
  }

  return {
    support,
    canRun,
    /** Native Bun on this machine, when runs go there (localBun.ts). */
    local,
    terminal,
    session,
    workspace,
    previews,
    vfs,
    log,
    /** Calls `fn` with every console line; returns the unsubscribe. */
    onLog(fn: (level: string, text: string) => void) {
      logListeners.add(fn);
      return () => void logListeners.delete(fn);
    },
    entryFile,
    run,
    install,
    test,
    stop,
    clearConsole,
    clearProject,
    newFile,
    missingDeps,
    start,
    get semver() {
      return semver;
    },
    /** What the last Run started. */
    get lastEntry() {
      return lastEntry;
    },
  };
}

export type Playground = ReturnType<typeof createPlayground>;
