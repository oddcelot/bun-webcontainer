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
import { checkSupport, showUnsupported } from "./support";
import { VFS } from "./vfs";
import { mountUI } from "./ui/mount";
import { createSession, type Status } from "./ui/session";
import { createPreviews } from "./ui/previews";
import { createWorkspace } from "./ui/workspace";
import { createConsole } from "./console";
import { createShell, scriptEntry } from "./shell";

const support = checkSupport();
/** False when a requirement is missing: the interface still loads, but nothing that runs code starts. */
const canRun = support.every((c) => c.ok);
if (!canRun) showUnsupported(support, document.querySelector("main")!);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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
mountUI({ session, workspace, previews, terminal, clearConsole, vfs, log, run: () => run(), install, openProject, newFile, openFolder, repoParam: new URLSearchParams(location.search).get("repo") ?? "" });
const params = new URLSearchParams(location.search);
const exampleName = params.get("example") ?? "";
const repoParam = params.get("repo") ?? "";
const repo = repoParam ? parseRepo(repoParam) : null;
if (repoParam && !repo) log("error", `[github] not a GitHub repo: ${repoParam}`);
// A share link (#code=…) carries the project itself; it wins over ?repo= and ?example=.
let shared = false;
if (isShareLink(location.hash)) {
  try {
    const n = await loadShareLink(vfs, location.hash);
    log("sys", `[share] opened a shared project: ${n} files`);
    shared = true;
  } catch (e) {
    log("error", "[share] this link is damaged or incomplete; opening the demo");
    vfs.clear();
  }
}
if (!shared) {
  // While these files stay unchanged, Share links to where they came from instead of packing them.
  if (repo && (await loadRepo(vfs, repo, log))) rememberSource(vfs, `?repo=${repoQuery(repo)}`, `${repoQuery(repo)} on GitHub`);
  else if (!repo && exampleName && (await loadExample(vfs, exampleName))) rememberSource(vfs, `?example=${exampleName}`, `the ${examples[exampleName] ?? exampleName} example`);
  else {
    seedDemo(vfs);
    rememberSource(vfs, "", "the demo");
  }
}

/** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
function openProject(value: string) {
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  if (value.startsWith("repo:")) url.searchParams.set("repo", value.slice(5));
  else if (value) url.searchParams.set("example", value);
  location.assign(url);
}

{
  const selected = repoParam ? `repo:${repoParam}` : exampleName;
  const extra: [string, string][] = [];
  if (repoParam && !(repoParam in repoExamples)) extra.push([`GitHub: ${repoParam}`, selected]);
  if (shared) extra.push(["Shared project", "#shared"]);
  session.setProject({ selected: shared ? "#shared" : repoParam || exampleName in examples ? selected : "", extra });
}
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

async function run(entry = entryFile()) {
  if (!runner) return cantRun();
  await session.task("run", "Starting…", async (): Promise<Status> => {
    log("sys", `[run] ${entry}`);
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

function stop() {
  if (session.settled().state !== "running") return;
  runner?.stop();
  log("sys", "[stopped]");
  session.setStatus({ state: "idle", text: "Stopped" });
}

function clearConsole() {
  terminal.clear();
  session.resetCounts();
}

const exec = createShell({ vfs, log, run, install, stop, clear: clearConsole });

async function openFolder(files: File[]) {
  runner?.stop();
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

function newFile(path: string) {
  vfs.write(path, "");
  openFile(path);
}
session.setReady(true);

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
