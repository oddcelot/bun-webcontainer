import { createRoot } from "solid-js";
import { BASE } from "./base";
import { createConsole } from "./console";
import { bunInstall } from "./install";
import { Runner } from "./runner";
import { setVfsOwner } from "./moduleServer";
import { setPreviewOwner } from "./preview";
import { loadSemver, type Semver } from "./semver";
import { createShell, scriptEntry } from "./shell";
import { checkSupport } from "./support";
import { createPreviews } from "./ui/previews";
import { createSession, type Status } from "./ui/session";
import { createWorkspace } from "./ui/workspace";
import { VFS } from "./vfs";

/**
 * The engine both pages share (index.html's full playground and embed.html): the VFS, the console, the session the UI
 * reads, and Run, Install, Test and Stop. Loading a project is the page's job; `start` then brings up the service
 * worker and the runner.
 */
export function createPlayground() {
  const support = checkSupport();
  /** False when a requirement is missing: the interface still loads, but nothing that runs code starts. */
  const canRun = support.every((c) => c.ok);
  const logListeners = new Set<(level: string, text: string) => void>();
  // The shell (see `start`) needs the runner, which comes later.
  let exec: (line: string) => Promise<void> = async () => {};
  const terminal = createConsole({
    onCommand: (line) => exec(line),
    onInterrupt: () => stop(),
    onClear: () => clearConsole(),
  });
  const [session, workspace, previews] = createRoot(() => [createSession(canRun), createWorkspace(), createPreviews()] as const);
  const vfs = new VFS();
  let runner: Runner | undefined;
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
  }

  /** The file Run starts: package.json's module/main or a `bun <file>` dev/start script, else a usual index file. */
  function entryFile(): string {
    try {
      const pkg = JSON.parse(vfs.readText("package.json") ?? "{}") as { module?: string; main?: string; scripts?: Record<string, string> };
      for (const e of [pkg.module, pkg.main, scriptEntry(pkg.scripts?.dev), scriptEntry(pkg.scripts?.start)])
        if (e && vfs.files.has(e.replace(/^\.\//, ""))) return e.replace(/^\.\//, "");
    } catch {}
    return ["index.ts", "index.tsx", "index.js", "src/index.ts"].find((f) => vfs.files.has(f)) ?? "index.ts";
  }

  /** What the last Run started, to start it again after `bun test` (which replaces the server). */
  let lastEntry: string | undefined;

  async function run(entry = entryFile()) {
    if (!runner) return cantRun();
    workspace.saveAll();
    await session.task("run", "Starting…", async (): Promise<Status> => {
      log("sys", `[run] ${entry}`);
      lastEntry = entry;
      try {
        await runner!.start(entry);
        previews.reload();
        return { state: "running", text: `Running ${entry}` };
      } catch (e) {
        log("error", String(e));
        return { state: "error", text: "Failed to start" };
      }
    });
  }

  async function install() {
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
    if (wasRunning) await run(lastEntry);
    return failed;
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

  /** Brings up the service worker, semver and the runner (when the browser can run code) and the console's shell. */
  async function start({ reset }: { reset(): Promise<void> }) {
    if (canRun) {
      await setupServiceWorker();
      semver = await loadSemver();
      runner = new Runner(vfs, log);
    }
    exec = createShell({ vfs, log, run, install, test, stop, clear: clearConsole, reset, cookies: runner?.cookies });
    session.markReady();
  }

  return {
    support,
    canRun,
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
  };
}

export type Playground = ReturnType<typeof createPlayground>;
