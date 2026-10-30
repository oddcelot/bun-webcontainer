import "virtual:uno.css";
import { BASE } from "./base";
import { seedDemo } from "./demo";
import { examples, loadExample, repoExamples } from "./examples";
import { loadRepo, parseRepo, repoQuery } from "./github";
import { createRoot } from "solid-js";
import { isShareLink, loadShareLink, rememberSource } from "./share";
import { bunInstall } from "./install";
import { Runner } from "./runner";
import { loadSemver } from "./semver";
import { checkSupport } from "./support";
import { VFS } from "./vfs";
import { mountUI } from "./ui/mount";
import { createSession, type Status } from "./ui/session";
import { createPreviews } from "./ui/previews";
import { createWorkspace } from "./ui/workspace";
import { createConsole } from "./console";
import { createShell, scriptEntry } from "./shell";
import { attach, discard, mirror, readDir, restore, shareProjectId } from "./persist";
import { importZip } from "./archive";
import { canWrite, lastFolder, rememberFolder } from "./folders";

const support = checkSupport();
/** False when a requirement is missing: the interface still loads, but nothing that runs code starts. */
const canRun = support.every((c) => c.ok);
// The shell (below) needs the runner and VFS, which come later.
const terminal = createConsole({
  onCommand: (line) => exec(line),
  onInterrupt: () => stop(),
  onClear: () => clearConsole(),
});
const [session, workspace, previews] = createRoot(() => [createSession(canRun), createWorkspace(), createPreviews()] as const);

function log(level: string, text: string) {
  terminal.log(level, text);
  session.countLine(level);
}

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
  if (!navigator.serviceWorker.controller) log("error", "service worker is not controlling this page; reload without hard-refresh");
}

const vfs = new VFS();
mountUI({ session, support, workspace, previews, terminal, clearConsole, vfs, log, run: () => run(), install, openProject, newFile, openFolder, openDirectory, reopenFolder, openZip, repoParam: new URLSearchParams(location.search).get("repo") ?? "" });
const params = new URLSearchParams(location.search);
const exampleName = params.get("example") ?? "";
const repoParam = params.get("repo") ?? "";
const repo = repoParam ? parseRepo(repoParam) : null;
if (repoParam && !repo) log("error", `[github] not a GitHub repo: ${repoParam}`);
/** Selects this page's project in the picker (`shared`: it came from a share link). */
function showProject(shared: boolean) {
  const selected = repoParam ? `repo:${repoParam}` : exampleName;
  const extra: [string, string][] = [];
  if (repoParam && !(repoParam in repoExamples)) extra.push([`GitHub: ${repoParam}`, selected]);
  if (shared) extra.push(["Shared project", "#shared"]);
  session.setProject({ selected: shared ? "#shared" : repoParam || exampleName in examples ? selected : "", extra });
}
// Right away, from the URL: a repo can take a while to fetch, and the picker shouldn't say "Confetti demo" meanwhile.
showProject(isShareLink(location.hash));

// Where this page's project is saved in OPFS (null: a bad ?repo=, which opens the demo unsaved).
const projectId = isShareLink(location.hash)
  ? await shareProjectId(location.hash)
  : repoParam
    ? repo
      ? `repo:${repoQuery(repo)}`
      : null
    : exampleName
      ? `example:${exampleName}`
      : "demo";
let stopSaving = async () => {};
// Saved files win over the source; without rememberSource, Share packs them.
const restored = projectId ? await restore(projectId, vfs, log) : 0;
if (restored) log("sys", `[storage] restored ${restored} saved files`);
/** True when the source loaded as asked: a fallback demo must not overwrite the saved project. */
let loaded = false;

// A share link (#code=…) carries the project itself; it wins over ?repo= and ?example=.
let shared = false;
if (!restored && isShareLink(location.hash)) {
  try {
    const n = await loadShareLink(vfs, location.hash);
    log("sys", `[share] opened a shared project: ${n} files`);
    shared = true;
    loaded = true;
  } catch (e) {
    log("error", "[share] this link is damaged or incomplete; opening the demo");
    vfs.clear();
  }
}
if (!shared && !restored) {
  // While these files stay unchanged, Share links to where they came from instead of packing them.
  if (repo && (await loadRepo(vfs, repo, log))) {
    rememberSource(vfs, `?repo=${repoQuery(repo)}`, `${repoQuery(repo)} on GitHub`);
    loaded = true;
  } else if (!repo && exampleName && (await loadExample(vfs, exampleName))) {
    rememberSource(vfs, `?example=${exampleName}`, `the ${examples[exampleName] ?? exampleName} example`);
    loaded = true;
  } else {
    seedDemo(vfs);
    rememberSource(vfs, "", "the demo");
    loaded = projectId === "demo";
  }
}
if (projectId && (restored || loaded)) stopSaving = await attach(projectId, vfs, log, !restored);

/** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
function openProject(value: string) {
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  url.searchParams.delete("folder");
  if (value.startsWith("repo:")) url.searchParams.set("repo", value.slice(5));
  else if (value) url.searchParams.set("example", value);
  location.assign(url);
}

// A damaged share link fell back to the demo.
if (isShareLink(location.hash) && !shared) showProject(false);
if (canRun) await setupServiceWorker();
const semver = canRun ? await loadSemver() : undefined;
const runner = canRun ? new Runner(vfs, log) : undefined;
const cantRun = () => log("error", "this browser can't run code here; see the banner above the editor");


const openFile = (path: string) => workspace.open(path);

vfs.onChange(({ path, removed }) => {
  if (removed) workspace.close(path);
});

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
      await runner.start(entry);
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
      const n = await bunInstall(vfs, semver, log);
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
    failed = await runner.runTests(files);
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

async function reset() {
  // A write still in flight would recreate the directory after the discard.
  await stopSaving();
  if (projectId) await discard(projectId).catch((e) => log("error", `[storage] reset failed: ${e}`));
  location.reload();
}

const exec = createShell({ vfs, log, run, install, test, stop, clear: clearConsole, reset, cookies: runner?.cookies });

async function openFolder(files: File[]) {
  await session.started;
  void stopSaving();
  // Finished before the clear: a database flushed afterwards would land in the opened folder.
  await runner?.stop();
  workspace.closeAll();
  vfs.clear();
  const dec = new TextDecoder("utf-8", { fatal: true });
  let n = 0;
  for (const f of files) {
    const rel = f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(1).join("/") : f.name;
    if (!rel || /(^|\/)(node_modules|\.git)\//.test(rel)) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    let data: string | Uint8Array = bytes;
    try {
      data = dec.decode(bytes);
    } catch {}
    vfs.write(rel, data);
    n++;
  }
  workspace.reloadTree();
  log("sys", `[open] ${files[0].webkitRelativePath.split("/")[0] || "files"}: ${n} files (node_modules skipped)`);
  openFile(entryFile());
}

/**
 * Opens a folder on disk (File System Access, Chromium) and writes edits back to it: `dir` (the last one, after
 * asking for access again) or one the user picks. node_modules and .git are neither read nor written: `bun install`
 * fills node_modules in the browser only.
 */
async function openDirectory(dir?: FileSystemDirectoryHandle) {
  if (dir) {
    if (!(await canWrite(dir, true))) return log("error", `[open] no access to ${dir.name}`);
  } else
    try {
      dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "bwc-folder", mode: "readwrite" });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) log("error", `[open] can't open the folder: ${e}`);
      return;
    }
  let files: [string, string | Uint8Array][];
  try {
    files = await readDir(dir);
  } catch (e) {
    return log("error", `[open] can't read ${dir.name}: ${e}`);
  }
  await session.started;
  await stopSaving();
  await runner?.stop();
  workspace.closeAll();
  vfs.clear();
  for (const [path, data] of files) vfs.write(path, data);
  // After the load: the files just read are on disk already.
  stopSaving = mirror(dir, vfs, log, { all: false, tag: "[folder]" });
  workspace.reloadTree();
  log("sys", `[open] ${dir.name}: ${files.length} files; changes are saved to the folder (node_modules stays in the browser)`);
  openFile(entryFile());
  // A reload opens it again (see the end of startup).
  void rememberFolder(dir);
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  url.searchParams.set("folder", dir.name);
  history.replaceState(null, "", url);
  session.setProject({ selected: "#folder", extra: [[`Folder: ${dir.name}`, "#folder"]], reopen: dir.name });
}

/** The project picker's "Reopen <folder>". */
async function reopenFolder() {
  const dir = await lastFolder();
  if (dir) await openDirectory(dir);
}

/** Opens a zip (a download from Share, a GitHub zip) the way a folder opens. */
async function openZip(file: File) {
  let entries: [string, string | Uint8Array][];
  try {
    entries = importZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return log("error", `[open] ${file.name} isn't a zip file this can read: ${e}`);
  }
  if (!entries.length) return log("error", `[open] ${file.name} has no files`);
  await session.started;
  void stopSaving();
  await runner?.stop();
  workspace.closeAll();
  vfs.clear();
  for (const [path, data] of entries) vfs.write(path, data);
  workspace.reloadTree();
  log("sys", `[open] ${file.name}: ${entries.length} files (node_modules skipped)`);
  openFile(entryFile());
}

async function newFile(path: string) {
  await session.started;
  vfs.write(path, "");
  openFile(path);
}
session.markReady();

// `?folder=`: the folder opened before the reload, if the browser still lets us write to it; else it's a click away.
const folder = "showDirectoryPicker" in window ? await lastFolder() : undefined;
if (folder) session.setProject({ ...session.project(), reopen: folder.name });
if (params.has("folder")) {
  if (folder && (await canWrite(folder, false))) await openDirectory(folder);
  else log("sys", `[open] pick "Reopen ${folder?.name ?? params.get("folder")}" in the project menu to keep working on the folder`);
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

openFile(entryFile());
if (canRun) {
  if (missingDeps()) await install();
  await run();
}
Object.assign(window, { vfs, semver });
