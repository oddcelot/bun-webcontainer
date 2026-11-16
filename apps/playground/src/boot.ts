import { createEffect, createRoot, createSignal } from "solid-js";
import { BASE } from "./base";
import { createConsole } from "./console";
import { CHECKED, diagnose } from "./diagnostics";
import { attachStore, reportStoreProblems } from "./pkgStore";
import { bunInstall } from "./install";
import { Runner, type TestResults } from "./runner";
import { RemoteRunner } from "./remoteRunner";
import { connectLocalBun, type LocalBun } from "./localBun";
import { setVfsOwner } from "./moduleServer";
import { setPreviewOwner } from "./preview";
import { CONTENT_ORIGIN } from "./contentOrigin";
import { connectHost, onHost, whenLost } from "./contentHost";
import { loadSemver, type Semver } from "./semver";
import { createShell } from "./shell";
import { commandOf, entryOf, type Command } from "./scripts";
import { checkSupport } from "./support";
import { createPreviews } from "./ui/previews";
import { createSession, type Status } from "./ui/session";
import { createGit } from "./git/store";
import { createWorkspace } from "./ui/workspace";
import { VFS } from "@runbun/vfs";

/**
 * The engine both pages share (index.html's full playground and embed.html): the VFS, the console, the session the UI
 * reads, and Run, Install, Test and Stop. Loading a project is the page's job; `start` then brings up the service
 * worker and the runner. `watch` says whether a save restarts the program (default: the workspace's Restart on save).
 */
/** A console path as the VFS keys it: `/index.ts` and `./index.ts` are `index.ts`. */
const bare = (path: string) => path.replace(/^\.?\//, "");

/** The runner on this machine: none for this page, being connected to, connected, or gone (stopped, or refused). */
export type LocalState = "none" | "connecting" | "connected" | "lost";
/** Where the reader last chose to run: "browser" keeps runs in the browser even with a runner connected. */
const RUNTIME_KEY = "runbun:runtime";
/** How long startup waits for the runner before running in the browser (see `start`). */
const LOCAL_WAIT_MS = 1500;

export function createPlayground({ watch, localUrl, git }: { watch?: () => boolean; localUrl?: string; git?: () => boolean } = {}) {
  const support = checkSupport();
  /** True when this browser can run the program itself (the in-browser runtime). */
  const browserOk = support.every((c) => c.ok);
  /**
   * False when a requirement is missing: the interface still loads, but nothing that runs code starts. With native
   * Bun on this machine (`localUrl`, see localBun.ts) the program runs there, so the browser needs no WebAssembly.
   */
  const canRun = support.every((c) => c.ok || (!!localUrl && c.name.startsWith("WebAssembly")));
  const logListeners = new Set<(level: string, text: string, partial: boolean) => void>();
  // The shell (see `start`) needs the runner, which comes later.
  let exec: ReturnType<typeof createShell> | undefined;
  const terminal = createConsole({
    onCommand: async (line) => exec?.(line),
    // Ctrl+C: the shell line that's running, and the program (like a shell's SIGINT).
    onInterrupt: () => {
      exec?.interrupt();
      stop();
    },
    cwd: () => exec?.cwd() ?? "/",
    // What is typed while the program reads its stdin (see `Runner.onStdinWait`); null is end of input (Ctrl+D).
    onInput: (data) => runner?.stdin(data),
    onClear: () => clearConsole(),
    isFile: (path) => vfs.files.has(bare(path)),
    onLocation: (path, line, column) => workspace.openAt(bare(path), line, column),
  });
  const [session, workspace, previews] = createRoot(() => {
    const session = createSession(canRun);
    return [session, createWorkspace(), createPreviews(() => session.settled().state === "running", (path) => vfs.readBytes(path))] as const;
  });
  // Where runs go: "local" (native Bun, via the runner) or "browser". `localState`: is there a runner to switch to.
  const [runtime, setRuntime] = createSignal<"local" | "browser">("browser");
  const [localState, setLocalState] = createSignal<LocalState>(localUrl ? "connecting" : "none");
  const [localInfo, setLocalInfo] = createSignal<{ bun: string; sandbox: string }>();
  const vfs = new VFS();
  attachStore(vfs);
  // The Git panel's state; git.wasm loads when it first has something to read (git/store.ts).
  const gitStore = createRoot(() => createGit(vfs, { enabled: git ?? (() => true), log: (level, text) => log(level, text), beforeRun: () => workspace.saveAll() }));
  let runner: Runner | RemoteRunner | undefined;
  /** Both runners, once used: switching between them keeps each (its cookies, the runner's node_modules). */
  let browserRunner: Runner | undefined;
  let remoteRunner: RemoteRunner | undefined;
  let local: LocalBun | undefined;
  let semver: Semver | undefined;

  function log(level: string, text: string, partial = false) {
    terminal.log(level, text, partial);
    // A partial line counts once it has ended.
    if (!partial || text.includes("\n")) session.countLine(level);
    for (const fn of logListeners) fn(level, text, partial);
  }
  reportStoreProblems((message) => log("warn", `[store] ${message}`));
  const cantRun = () => log("error", "this browser can't run code. See the banner above the editor.");

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
    if (!navigator.serviceWorker.controller) return log("error", "reload the page normally to start the service worker");
    // Which client this page is to the worker: module URLs carry it, so the worker asks this page for its files.
    const ch = new MessageChannel();
    const answer = new Promise<string>((r) => (ch.port1.onmessage = (e) => r(e.data)));
    navigator.serviceWorker.controller.postMessage({ type: "whoami" }, [ch.port2]);
    const id = await Promise.race([answer, new Promise<undefined>((r) => setTimeout(r, 3000))]);
    if (CONTENT_ORIGIN) {
      // Project code runs on the content origin: its module and preview URLs name the host frame, which answers there.
      // A host frame made later (after the first was lost) has another id.
      onHost((host) => {
        setVfsOwner(host.id);
        setPreviewOwner(host.id);
      });
      whenLost((reason) => {
        log("error", `the runtime host stopped: ${reason}. Run starts it again.`);
        session.setStatus({ state: "error", text: "Runtime host stopped · Run to restart" });
      });
      try {
        await connectHost();
      } catch (err) {
        log("error", `couldn't start the runtime host: ${err instanceof Error ? err.message : err}. Run to retry.`);
      }
    } else if (id) {
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

  /**
   * Runs `entry` (default: what Run starts). `swap` (a save under watch): the program keeps serving while the new one
   * starts in the browser, and keeps going if that fails (Runner.swap); native Bun restarts it as a Run does.
   */
  async function startRun(entry?: string, args: string[] = [], swap = false) {
    if (entry === undefined) ({ entry, args } = command());
    if (!runner) return cantRun();
    if (runner instanceof RemoteRunner && !(await mayRunNative())) return;
    workspace.saveAll();
    await session.task("run", swap ? "Restarting…" : "Starting…", async (): Promise<Status | void> => {
      log("sys", `[run] ${[entry, ...args].join(" ")}`);
      lastEntry = entry;
      lastArgs = args;
      try {
        if (swap && !(runner instanceof RemoteRunner)) {
          const result = await runner!.swap(entry!, args);
          if (result.kind === "superseded") return; // what came after it sets the status
          if (result.kind === "failed") {
            if (!runner!.running) return exited(runner!.exitCode ?? 1);
            log("error", `[watch] restart failed: ${result.reason}. The previous run is still going.`);
            return { state: "running", text: `Running ${entry} · last save failed to start` };
          }
        } else await runner!.start(entry!, undefined, args);
        if (runner!.exitCode !== undefined) return exited(runner!.exitCode);
        previews.reload();
        return { state: "running", text: `Running ${entry}` };
      } catch (e) {
        log("error", String(e));
        return { state: "error", text: "Failed to start" };
      }
    });
  }

  async function startInstall() {
    if (runner instanceof RemoteRunner) {
      // `bun install` runs packages' install scripts: someone else's code too.
      if (!(await mayRunNative())) return;
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

  /** True while `bun test` runs, so Stop ends it; `stoppedTest` once Stop (or clearing the project) did. */
  let testing = false;
  let stoppedTest = false;

  /** `bun test`: a fresh worker runs the files; a server that was running is started again afterwards, unless stopped. */
  async function runTests(files: string[]): Promise<TestResults> {
    if (!runner) return cantRun(), { failed: 0 };
    if (runner instanceof RemoteRunner && !(await mayRunNative())) return { failed: 0 };
    workspace.saveAll();
    const wasRunning = session.settled().state === "running";
    // Previews sent meanwhile wait for the server to be back, not just for the test to end.
    const testRunner = runner;
    let restored = () => {};
    if (wasRunning) testRunner.restoring = new Promise<void>((r) => (restored = r));
    let tested: TestResults = { failed: 0 };
    testing = true;
    stoppedTest = false;
    try {
      try {
        await session.task("run", "Testing…", async (): Promise<Status> => {
          tested = await runner!.runTests(files);
          const { failed } = tested;
          if (stoppedTest) return { state: "idle", text: "Stopped" };
          return failed ? { state: "error", text: `${failed} test${failed === 1 ? "" : "s"} failed` } : { state: "idle", text: "Tests passed" };
        });
      } finally {
        testing = false;
      }
      if (wasRunning && !stoppedTest) await startRun(lastEntry, lastArgs);
    } finally {
      testRunner.restoring = undefined;
      restored();
    }
    return tested;
  }

  /**
   * Runs and tests take turns. Each starts a worker in place of the last, and one started while another was under way
   * terminated that one's worker before it answered: the first never settled, and Run stayed busy.
   */
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> => {
      const done = turn.then(() => fn(...args));
      turn = done.catch(() => {});
      return done;
    };
  }
  const queuedRun = inTurn(startRun);
  /** A save under watch still waiting its turn gives way to a newer one: only the latest edit restarts the program. */
  let saves = 0;
  const restartForSave = inTurn((save: number, entry?: string, args: string[] = []) => (save === saves ? startRun(entry, args, true) : Promise.resolve()));
  const run = (entry?: string, args: string[] = [], swap = false) => (swap ? restartForSave(++saves, entry, args) : queuedRun(entry, args));
  const test = inTurn(runTests);
  // In turn too, so a run or test asked for during an install (startup's, say) sees the installed packages.
  const install = inTurn(startInstall);

  /** The program ended itself (process.exit, an uncaught error): the console and status say with which code. */
  function exited(code: number): Status {
    log("sys", `[exited with code ${code}]`);
    if (!code) return { state: "idle", text: "Exited" };
    // A crash doesn't end watching (see below): the status says a save is enough.
    return { state: "error", text: watching && watchOn() ? `Exited with code ${code} · reruns on save` : `Exited with code ${code}` };
  }

  function stop() {
    if (session.settled().state !== "running" && !testing) return;
    stoppedTest = testing;
    void runner?.stop();
    log("sys", "[stopped]");
    session.setStatus({ state: "idle", text: "Stopped" });
  }

  /** Shows the server on `port` in the preview, one of several the program and its child processes serve. */
  function choosePort(port: number) {
    if (!runner || runner instanceof RemoteRunner) return;
    runner.choosePort(port);
    previews.reload();
  }

  function clearConsole() {
    terminal.clear();
    session.resetCounts();
  }

  /** Clears the project (after stopping the program) to load another into the VFS. */
  async function clearProject() {
    await session.started;
    // Finished before the clear: a database flushed afterwards would land in the next project.
    stoppedTest = testing;
    await runner?.stop();
    workspace.closeAll();
    vfs.clear();
  }

  async function newFile(path: string) {
    await session.started;
    vfs.write(path, "");
    workspace.open(path);
  }

  /**
   * Moves a file, or a folder with everything in it, as the file tree's rename does. Unsaved edits are saved first and
   * go with it; open tabs follow it. Counts as a save the reader made, so Watch restarts the program. Returns the undo:
   * the move back, unless something has taken the old path since.
   */
  async function renamePath(from: string, to: string): Promise<() => Promise<void>> {
    await session.started;
    workspace.saveAll();
    // Before the move: its events close the tabs of paths that no longer exist.
    workspace.rename(from, to);
    vfs.rename(from, to);
    workspace.markSaved();
    return async () => {
      if (vfs.exists(from)) return log("warn", `[files] can't undo the rename: ${from} exists again`);
      await renamePath(to, from);
    };
  }

  /**
   * Deletes a file, or a folder with everything in it (their tabs close); like a save for Watch. Returns the undo: the
   * files back as they were (but those written again since), their tabs open again.
   */
  async function removePath(path: string): Promise<() => Promise<void>> {
    await session.started;
    workspace.saveAll();
    const p = path.replace(/\/$/, "");
    const gone = [...vfs.files].filter(([k]) => k === p || k.startsWith(`${p}/`));
    const paths = new Set(gone.map(([k]) => k));
    const tabs = workspace.state.open.filter((t) => paths.has(t));
    const active = workspace.state.active;
    vfs.remove(p);
    workspace.markSaved();
    return async () => {
      await session.started;
      for (const [k, data] of gone) if (!vfs.files.has(k)) vfs.write(k, data);
      for (const t of tabs) workspace.open(t);
      if (active && tabs.includes(active)) workspace.activate(active);
      workspace.markSaved();
    };
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
      if (at !== waitingFor) log("sys", `[watch] syntax error in ${at}: ${message}`);
      waitingFor = at;
      session.setStatus({ state: session.settled().state, text: `Syntax error in ${at} · fix it to restart` });
      return;
    }
    waitingFor = undefined;
    clearConsole();
    log("sys", "[watch] restarting");
    void run(lastEntry, lastArgs, true);
  }
  workspace.onSaved(() => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(restart, WATCH_DELAY);
  });


  /** Connects to the runner on this machine; says so in the console when it takes long or fails. */
  async function connectLocal(url: string) {
    const fallback = browserOk ? "Runs stay in the browser." : "Nothing can run here until it connects.";
    const meanwhile = browserOk ? " Runs start in the browser meanwhile." : "";
    local = await connectLocalBun(url, () =>
      log("sys", `[local] connecting to the local runner.${meanwhile} Allow local network access if the browser asks.`),
    );
    if (!local) {
      setLocalState("lost");
      return log("error", `[local] can't reach the local runner. Start it with bunx @runbun/connect and allow access. ${fallback}`);
    }
    setLocalInfo({ bun: local.bun, sandbox: local.sandbox });
    setLocalState("connected");
    void local.closed.then(async () => {
      setLocalState("lost");
      const reload = "Restart it (bunx @runbun/connect) and reload";
      if (runtime() !== "local") return log("sys", `[local] the local runner disconnected. ${reload} to use it.`);
      if (!browserOk) return log("error", `[local] the local runner disconnected. ${reload} to run code.`);
      log("error", "[local] the local runner disconnected");
      await useRuntime("browser");
    });
  }

  /**
   * Makes `kind` the runner Run, Install and Test use; a program still running on the other one is stopped. The
   * in-browser runtime (semver, its runner) loads on first use.
   */
  async function useRuntime(kind: "local" | "browser") {
    let next: Runner | RemoteRunner;
    if (kind === "local") {
      if (!local || localState() !== "connected") return;
      next = remoteRunner ??= new RemoteRunner(vfs, log, local);
    } else {
      if (!browserOk) return;
      semver ??= await loadSemver();
      next = browserRunner ??= new Runner(vfs, log);
    }
    if (next === runner) return;
    const previous = runner;
    runner = next;
    runner.attach();
    runner.onExit = (code) => session.setStatus(exited(code));
    runner.onStdinWait = (on) => terminal.reading(on);
    runner.onPorts = (ports, shown) => {
      session.setPorts(ports);
      session.setPreviewPort(shown);
    };
    setRuntime(kind);
    if (previous) {
      if (session.settled().state === "running") session.setStatus({ state: "idle", text: "Stopped" });
      await previous.stop();
    }
    // Without a runner for this page, the browser is the only runtime: nothing to say.
    if (kind === "local") log("sys", `[local] running on Bun ${local!.bun} on this machine, sandbox ${local!.sandbox}`);
    else if (localUrl) log("sys", "[browser] running in the browser");
  }

  /**
   * Where the project came from when it's someone else's code (a share link, a GitHub repo; see `start`): native Bun
   * runs it only once the reader agreed, once per page. While asking, `asking` is that source.
   */
  let untrustedFrom: string | undefined;
  const [asking, setAsking] = createSignal<string>();
  let answer: ((ok: boolean) => void) | undefined;
  async function mayRunNative(): Promise<boolean> {
    if (untrustedFrom === undefined) return true;
    answer?.(false);
    const ok = await new Promise<boolean>((r) => {
      answer = r;
      setAsking(untrustedFrom);
    });
    setAsking(undefined);
    answer = undefined;
    if (ok) untrustedFrom = undefined;
    else log("sys", "[local] cancelled. Nothing ran on this machine.");
    return ok;
  }

  /**
   * The header's switch: runs go to `kind` from now on (and on later visits). A running program starts again there;
   * moving to the browser installs first if node_modules is missing (the runner's own stays on the runner).
   */
  async function switchRuntime(kind: "local" | "browser") {
    await session.started;
    if (kind === runtime()) return;
    if (kind === "local" && !(await mayRunNative())) return;
    localStorage.setItem(RUNTIME_KEY, kind);
    const wasRunning = session.settled().state === "running";
    await useRuntime(kind);
    if (kind === "browser" && missingDeps()) await install();
    if (wasRunning && lastEntry !== undefined) await run(lastEntry, lastArgs);
  }

  /**
   * Another project opened in place (main.ts): `from` names it when it's someone else's code. Like `start`, that keeps
   * it in the browser, where it can't reach this machine, until the reader moves it; one of the reader's own goes
   * where they last chose to run.
   */
  async function opened(from?: string) {
    untrustedFrom = from;
    answer?.(false);
    if (!local || localState() !== "connected" || !browserOk) return;
    const kind = from === undefined && localStorage.getItem(RUNTIME_KEY) !== "browser" ? "local" : "browser";
    await useRuntime(kind);
    if (from !== undefined) log("sys", `[local] ${from} runs in the browser. Press Local Bun to use this machine.`);
  }

  /** Brings up the service worker, semver and the runner (when the browser can run code) and the console's shell. */
  async function start({ reset, from }: { reset(): Promise<void>; from?: string }) {
    if (canRun) {
      await setupServiceWorker();
      // A runner that answers at once (it serves this page, or the browser allowed access before) decides where the
      // first run goes. One still waiting on the browser's permission prompt doesn't hold the page up where the
      // browser can run code itself: the project opens and runs there, and moves to the runner once it connects.
      let later: Promise<void> | undefined;
      if (localUrl) {
        const connecting = connectLocal(localUrl);
        const answered = await Promise.race([connecting.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), LOCAL_WAIT_MS))]);
        if (answered || !browserOk) await connecting;
        else later = connecting;
      }
      untrustedFrom = from;
      // Someone else's project stays in the browser (where it can't reach this machine) until the reader moves it.
      const preferBrowser = (from !== undefined || localStorage.getItem(RUNTIME_KEY) === "browser") && browserOk;
      await useRuntime(local && !preferBrowser ? "local" : "browser");
      if (local && from !== undefined && browserOk) log("sys", `[local] ${from} runs in the browser. Press Local Bun to use this machine.`);
      void later?.then(async () => {
        if (!local || preferBrowser) return;
        await session.started;
        // Not in the middle of startup's install or run: the switch restarts a running program on the runner.
        while (session.busy.run || session.busy.install) await new Promise((r) => setTimeout(r, 200));
        await switchRuntime("local");
      });
    }
    exec = createShell({ vfs, log, run, install, test, stop, clear: clearConsole, reset, git, gitRan: () => gitStore.commandRan(),
      gitProgress: (() => {
        // The status pill says what `git fetch` is doing, then goes back to what it said before.
        let before: ReturnType<typeof session.settled> | undefined;
        return (text: string | null) => {
          if (text === null) {
            if (before) session.setStatus(before);
            before = undefined;
            return;
          }
          before ??= session.settled();
          session.setStatus({ state: "busy", text: `git · ${text}` });
        };
      })(), cookies: runner && { list: () => runner!.listCookies(), clear: () => runner!.clearCookies() } });
    session.markReady();
  }

  return {
    support,
    canRun,
    /** The Git panel's state over the project's files. */
    git: gitStore,
    /** Where runs go, and the runner on this machine (localBun.ts) to switch to. */
    runtime: {
      current: runtime,
      local: localState,
      /** Native Bun's version and sandbox, once connected. */
      info: localInfo,
      /** Whether this browser can run the program itself. */
      browserOk,
      switchTo: switchRuntime,
      /** Where the project came from, while asking whether to run it on this machine; `answer` replies. */
      asking,
      answer: (ok: boolean) => answer?.(ok),
    },
    terminal,
    session,
    workspace,
    previews,
    vfs,
    log,
    /** Calls `fn` with every console line (`partial`: text that ends mid-line, a prompt); returns the unsubscribe. */
    onLog(fn: (level: string, text: string, partial: boolean) => void) {
      logListeners.add(fn);
      return () => void logListeners.delete(fn);
    },
    entryFile,
    run,
    install,
    test,
    stop,
    choosePort,
    clearConsole,
    clearProject,
    opened,
    newFile,
    renamePath,
    removePath,
    missingDeps,
    start,
    get semver() {
      return semver;
    },
    /** What the last Run started. */
    get lastEntry() {
      return lastEntry;
    },
    /** True while the running program's file writes reach the VFS (see Runner.applying). */
    get programWriting() {
      return !!runner?.applying;
    },
  };
}

export type Playground = ReturnType<typeof createPlayground>;
