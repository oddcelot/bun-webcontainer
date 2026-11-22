import "virtual:uno.css";
import { seedDemo } from "./demo";
import { examples, loadExample, repoExamples } from "./examples";
import { HOSTING } from "./hosting";
import { loadRepo, parseRepo, repoQuery } from "./github";
import { isShareLink, loadShareLink, rememberSource } from "./share";
import { createPlayground } from "./boot";
import { VFS } from "@runbun/vfs";
import { findLocalBun } from "./localBun";
import { mountUI } from "./ui/mount";
import { attach, discard, heldProjects, listProjects, mirror, readDir, restore, shareProjectId, type StopSaving } from "./persist";
import { clearPkgCache } from "./pkgCache";
import { clearStore } from "./pkgStore";
import { clearTranspileCache } from "./transpileCache";
import { importZip } from "./archive";
import { canWrite, lastFolder, rememberFolder } from "./folders";
import { setThemeVars, urlVars } from "./theme";
import { showCanaryBadge } from "./canary";
import { setBaseline, setBaselineSource } from "./changes";
import { parseRequests } from "./embed/requests";
import { CONFIG_FILE, readConfig, type ProjectConfig } from "./projectConfig";
import { git, release } from "./git/git";
import { gitName, gitUrl } from "./git/remoteUrl";

showCanaryBadge();

/** The open project's saved id (null: not saved); set as each project loads. */
let projectId: string | null = null;
let firstLoaded!: () => void;
const firstLoad = new Promise<void>((r) => (firstLoaded = r));
/** The open project's saved id, once the first one has loaded (the Storage dialog marks it). */
const currentProject = () => firstLoad.then(() => projectId);

// Native Bun on this machine, when the playground is served by `bunx @runbun/connect` or has ?connect= (localBun.ts);
// `pg.start` connects to it.
const localUrl = await findLocalBun(new URLSearchParams(location.search));
const pg = createPlayground({ localUrl });
const { support, session, workspace, previews, terminal, vfs, log, run, stop, install, clearConsole, newFile, renamePath, removePath, entryFile } = pg;
mountUI({ git: pg.git, session, support, runtime: pg.runtime, workspace, previews, terminal, clearConsole, vfs, log, run: () => run(), stop, choosePort: pg.choosePort, install, openProject, newFile, renamePath, removePath, openFolder, openDirectory, reopenFolder, openZip, storage: { current: currentProject, remove: removeProject, clearAll }, repoParam: new URLSearchParams(location.search).get("repo") ?? "" });
const params = new URLSearchParams(location.search);
// ?vars= sets the overlay for this visit (theme.ts allows only that); not saved, and Share links drop it.
if (params.has("vars")) setThemeVars(urlVars(params.get("vars")));

/**
 * The project a URL names: `?git=` (a repository cloned with its history), else `?repo=` (a GitHub repo's files), else
 * `?example=` (none: the demo); a share link in its hash wins over all of them.
 */
function sourceOf(url: URL) {
  const repoParam = url.searchParams.get("repo") ?? "";
  const gitParam = url.searchParams.get("git") ?? "";
  const cloned = gitParam ? gitUrl(gitParam) : null;
  const share = isShareLink(url.hash) ? url.hash : "";
  // A URL that names no project opens the hosting file's defaultProject (src/hosting.ts), else the demo.
  const named = repoParam || gitParam || share || url.searchParams.has("example") || url.searchParams.has("folder");
  return {
    exampleName: url.searchParams.get("example") ?? (named ? "" : (HOSTING.defaultProject ?? "")),
    repoParam,
    repo: repoParam ? parseRepo(repoParam) : null,
    gitParam,
    gitRemote: cloned && "url" in cloned ? cloned.url : null,
    share,
  };
}
type Source = ReturnType<typeof sourceOf>;
/** Which project a URL opens, to tell whether Back or Forward lands on another one. */
const keyOf = (url: URL) => {
  const { exampleName, repoParam, gitParam, share } = sourceOf(url);
  return JSON.stringify([exampleName, repoParam, gitParam, share, url.searchParams.get("folder")]);
};

/** Selects the project in the gallery (`shared`: it came from a share link). */
function showProject({ exampleName, repoParam, gitRemote }: Source, shared: boolean) {
  const selected = gitRemote ? `git:${gitRemote}` : repoParam ? `repo:${repoParam}` : exampleName;
  const extra: [string, string][] = [];
  if (gitRemote) extra.push([`Git: ${gitName(gitRemote)}`, selected]);
  else if (repoParam && !(repoParam in repoExamples)) extra.push([`GitHub: ${repoParam}`, selected]);
  if (shared) extra.push(["Shared project", "#shared"]);
  session.setProject({ ...session.project(), selected: shared ? "#shared" : gitRemote || repoParam || exampleName in examples ? selected : "", extra });
}

/** "1.2 MB" (or "340 KB"). */
const megabytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** How many commits a clone brings (more with `git fetch --depth`). */
const CLONE_DEPTH = 50;

let stopSaving: StopSaving = async () => {};

/** A project loaded (see `loadProject`), not yet saved: `startSaving` takes it from there. */
type Loaded = { id: string | null; save: boolean; fresh: boolean; from?: string; settle: (() => void)[] };

/**
 * Loads the project `url` names into the empty `into` (its saved files, else its source). `from` names where it came
 * from when it's someone else's code (a share link, a GitHub repo). What Share and the Changes tab learn about it waits
 * in `settle` until the files are in the playground's VFS (`startSaving`): the last project shows until then.
 */
async function loadProject(url: URL, into: VFS): Promise<Loaded> {
  const src = sourceOf(url);
  const { exampleName, repoParam, repo, gitParam, gitRemote, share } = src;
  if (repoParam && !repo) log("error", `[github] not a GitHub repo: ${repoParam}`);
  if (gitParam && !gitRemote) log("error", `[git] can't clone ${gitParam}: ${(gitUrl(gitParam) as { error: string }).error}`);
  // Right away: a repo can take a while to fetch, and the gallery shouldn't name the last project meanwhile.
  showProject(src, !!share);

  // Where the project is saved in OPFS (null: a bad ?repo=, which opens the demo unsaved).
  const id = share
    ? await shareProjectId(share)
    : gitParam
      ? gitRemote && `git:${gitRemote}`
      : repoParam
        ? repo && `repo:${repoQuery(repo)}`
        : exampleName
          ? `example:${exampleName}`
          : "demo";
  // Saved files win over the source; without rememberSource, Share packs them.
  const restored = id ? await restore(id, into, log) : 0;
  if (restored) log("sys", `[storage] restored ${restored} saved files`);
  /** True when the source loaded as asked: a fallback demo must not overwrite the saved project. */
  let loaded = false;
  const settle: (() => void)[] = [];

  // A share link (#code=…) carries the project itself; it wins over ?repo= and ?example=.
  let shared = false;
  if (!restored && share) {
    try {
      const n = await loadShareLink(into, share);
      log("sys", `[share] opened a shared project: ${n} files`);
      shared = true;
      loaded = true;
    } catch (e) {
      log("error", "[share] this link is broken. Opening the demo instead.");
      into.clear();
    }
  }
  if (!shared && !restored) {
    // While these files stay unchanged, Share links to where they came from instead of packing them.
    if (gitRemote && (await cloneInto(into, gitRemote))) {
      settle.push(() => rememberSource(vfs, `?git=${encodeURIComponent(gitRemote)}`, `${gitName(gitRemote)} (Git)`));
      loaded = true;
    } else if (!gitParam && repo && (await loadRepo(into, repo, log))) {
      settle.push(() => rememberSource(vfs, `?repo=${repoQuery(repo)}`, `${repoQuery(repo)} on GitHub`));
      loaded = true;
    } else if (!gitParam && !repo && exampleName && (await loadExample(into, exampleName))) {
      settle.push(() => rememberSource(vfs, `?example=${exampleName}`, `the ${examples[exampleName] ?? exampleName} example`));
      loaded = true;
    } else {
      seedDemo(into);
      settle.push(() => rememberSource(vfs, "", "the demo"));
      loaded = id === "demo";
    }
  }
  // The Changes tab compares against the source: as just loaded, or rebuilt from it for a restored project.
  settle.push(() => {
    if (!restored) setBaseline(vfs);
    else if (share) setBaselineSource((scratch) => loadShareLink(scratch, share));
    // A clone compares with its last commit (git/store.ts) once git has read it; nothing to rebuild before that.
    else if (gitRemote) setBaseline(vfs);
    else if (repo) setBaselineSource((scratch) => loadRepo(scratch, repo, log), { costly: true });
    else if (exampleName) setBaselineSource((scratch) => loadExample(scratch, exampleName));
    else setBaselineSource(seedDemo);
  });
  // A damaged share link fell back to the demo.
  if (share && !shared) showProject(src, false);
  // Someone else's code: native Bun on this machine runs it only once the reader agrees (boot.ts, mayRunNative).
  const from = share ? "this shared project" : gitRemote ? gitName(gitRemote) : repo ? `${repoQuery(repo)} from GitHub` : undefined;
  return { id, save: !!restored || loaded, fresh: !restored, from, settle };
}

/**
 * Takes the project now in the VFS from here: Share and the Changes tab learn its source, and it saves from now on
 * (`fresh`: every file, as it just came from its source).
 */
async function startSaving({ id, save, fresh, settle }: Loaded) {
  for (const fn of settle) fn();
  if (id && save) stopSaving = await attach(id, vfs, log, fresh);
  projectId = id;
}

const first = await loadProject(new URL(location.href), vfs);
await startSaving(first);
let from = first.from;
let openKey = keyOf(new URL(location.href));
firstLoaded();

/**
 * Clones `remote` (an https URL, git/remoteUrl.ts) into the empty `into`, with the last commits of its default branch,
 * through the git worker and proxy. False (logged) when it fails.
 */
async function cloneInto(into: VFS, remote: string): Promise<boolean> {
  log("sys", `[git] cloning ${gitName(remote)}…`);
  try {
    const name = gitName(remote);
    const show = (what: string) => session.setStatus({ state: "busy", text: `Cloning ${name} · ${what}` });
    show("connecting");
    const r = await git(into, ["clone", "--depth", String(CLONE_DEPTH), remote], {
      colors: false,
      // git's line until the pack is coming in, then how much of it, then git's line again (checking out).
      onProgress: (p) => show(p.text?.startsWith("Checking out") || !p.bytes ? (p.text ?? "connecting").replace(/^Connecting/, "connecting").replace(/^Checking/, "checking") : `${megabytes(p.bytes)} received`),
    });
    for (const line of r.stderr.split("\n").filter((l) => l && !l.startsWith("Cloning into"))) log(r.exitCode ? "error" : "log", `[git] ${line}`);
    if (r.exitCode) return false;
    log("sys", `[git] cloned ${gitName(remote)}, last ${CLONE_DEPTH} commits. Run git fetch --depth <n> for more.`);
    return true;
  } catch (e) {
    log("error", `[git] ${e instanceof Error ? e.message : e}`);
    return false;
  } finally {
    // The worker cloned into this VFS; the open project's own starts when git is next used.
    if (into !== vfs) await release(into);
  }
}

/** Opens a project from the gallery (`repo:<query>` for a repo, `""` the demo) in place of this one, with its URL. */
function openProject(value: string) {
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  url.searchParams.delete("git");
  url.searchParams.delete("folder");
  if (value.startsWith("repo:")) url.searchParams.set("repo", value.slice(5));
  else if (value.startsWith("git:")) url.searchParams.set("git", value.slice(4));
  else if (value) url.searchParams.set("example", value);
  history.pushState(null, "", url);
  void switchTo(url);
}

// Back and Forward between projects switch in place too. A folder asks for access again, which needs a click: the
// reload offers it (see the end of startup).
addEventListener("popstate", () => {
  const url = new URL(location.href);
  if (keyOf(url) === openKey) return;
  if (url.searchParams.has("folder")) return location.reload();
  void switchTo(url);
});

let switching = Promise.resolve();
/**
 * Replaces the open project with the one `url` names, without reloading the page: the header, console and preview
 * stay, and the project then installs and runs as at startup. The next one loads aside (a repo can take a while)
 * while the last one stays on screen, then takes its place in one go. Switches run one after another.
 */
function switchTo(url: URL) {
  openKey = keyOf(url);
  switching = switching
    .then(async () => {
      await session.started;
      clearConsole();
      const next = new VFS();
      const loaded = await loadProject(url, next);
      // Not in the middle of an install or a run starting: either would write into, or run, the next project.
      while (session.busy.run || session.busy.install) await new Promise((r) => setTimeout(r, 100));
      workspace.saveAll();
      await stopSaving({ flush: true });
      stopSaving = async () => {};
      stop();
      await pg.clearProject();
      // From the clear to the entry file opening, nothing awaits: no frame paints an empty editor or tree.
      for (const [path, data] of next.files) vfs.write(path, data);
      previews.reset();
      workspace.reloadTree();
      const config = applyConfig();
      // Into the new project's code, once the editor shows it (a pick from the gallery left focus nowhere).
      setTimeout(() => workspace.reveal(1, 1));
      await startSaving(loaded);
      from = loaded.from;
      await pg.opened(from);
      await begin(config);
    })
    .catch((e) => log("error", `[open] ${e}`));
  return switching;
}

const openFile = (path: string) => workspace.open(path);

/**
 * What the project's runbun.json asks for once it's loaded: its tabs (else the entry file), panels and sizes, preview path or
 * requests, and a word on what it needs that this page lacks. Returns it for `begin`. Problems with the file are
 * logged, the rest of it still applies.
 */
function applyConfig(): ProjectConfig {
  const problems: string[] = [];
  const config = readConfig((path) => vfs.readText(path), problems);
  for (const p of problems) log("warn", `[config] ${p}`);
  const hidden = new Set(config.hidden ?? []);
  if (workspace.isHiddenConfig(CONFIG_FILE)) hidden.add(CONFIG_FILE);
  workspace.setReadonly(config.readonly ?? []);
  const tabs = (config.open ?? []).filter((p) => vfs.files.has(p) && !hidden.has(p));
  for (const path of tabs) openFile(path);
  if (tabs.length) workspace.activate(tabs[0]);
  else if (!hidden.has(entryFile())) openFile(entryFile());
  workspace.setSizes(config.sizes ?? null);
  // The host's `panels` under the project's: a pane neither names stays as the reader left it.
  workspace.setPanels(HOSTING.panels || config.panels ? { ...HOSTING.panels, ...config.panels } : null);
  const presets = parseRequests((config.preview?.requests ?? []).join("; "));
  if (presets.length) previews.presets(presets);
  else if (config.preview?.path) previews.start(config.preview.path);
  for (const need of config.requires ?? []) {
    if (need === "cross-origin-isolation" && !crossOriginIsolated)
      log("warn", "[config] this project needs cross-origin isolation, which this page doesn't have. Open it on runbun.dev.");
    if (need === "local-bun" && pg.runtime.current() !== "local") log("warn", "[config] this project needs Bun on this machine. Press Local Bun.");
  }
  return config;
}

async function reset() {
  // A write still in flight would recreate the directory after the discard.
  await stopSaving();
  if (projectId) await discard(projectId).catch((e) => log("error", `[storage] reset failed: ${e}`));
  location.reload();
}

await pg.start({ reset, from });

/** Deletes a saved project; this page's own reloads from its source, like `reset`. */
async function removeProject(id: string) {
  if (id === (await currentProject())) return reset();
  await discard(id);
}

/** Deletes every saved project but those open in other tabs, and the package and transpile caches; then reloads. */
async function clearAll() {
  const current = await currentProject();
  await stopSaving();
  const held = await heldProjects();
  const gone = (await listProjects()).filter((p) => p.id === current || !held.has(p.id));
  await Promise.all([...gone.map((p) => discard(p.id)), clearPkgCache(), clearStore(), clearTranspileCache()]);
  location.reload();
}

async function openFolder(files: File[]) {
  await session.started;
  void stopSaving();
  await pg.clearProject();
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
  setBaseline(vfs);
  workspace.reloadTree();
  log("sys", `[open] ${files[0].webkitRelativePath.split("/")[0] || "files"}: ${n} files, node_modules skipped`);
  applyConfig();
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
  await pg.clearProject();
  for (const [path, data] of files) vfs.write(path, data);
  setBaseline(vfs);
  // After the load: the files just read are on disk already.
  stopSaving = mirror(dir, vfs, log, { all: false, tag: "[folder]", where: "folder", watch: true });
  workspace.reloadTree();
  log("sys", `[open] ${dir.name}: ${files.length} files. Edits save to the folder; node_modules stays in the browser.`);
  applyConfig();
  // A reload opens it again (see the end of startup).
  void rememberFolder(dir);
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  url.searchParams.set("folder", dir.name);
  history.replaceState(null, "", url);
  openKey = keyOf(url);
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
    return log("error", `[open] couldn't read ${file.name} as a zip: ${e}`);
  }
  if (!entries.length) return log("error", `[open] ${file.name} has no files`);
  await session.started;
  void stopSaving();
  await pg.clearProject();
  for (const [path, data] of entries) vfs.write(path, data);
  setBaseline(vfs);
  workspace.reloadTree();
  log("sys", `[open] ${file.name}: ${entries.length} files, node_modules skipped`);
  applyConfig();
}


// `?folder=`: the folder opened before the reload, if the browser still lets us write to it; else it's a click away.
const folder = "showDirectoryPicker" in window ? await lastFolder() : undefined;
if (folder) session.setProject({ ...session.project(), reopen: folder.name });
if (params.has("folder")) {
  if (folder && (await canWrite(folder, false))) await openDirectory(folder);
  else log("sys", `[open] to keep editing the folder, use "Reopen ${folder?.name ?? params.get("folder")}" in the project menu.`);
}

/**
 * Runs the project, installing first; someone else's code waits for the reader's Run, and so does a project whose
 * runbun.json says `"autorun": false` (it still installs, for its types).
 */
async function begin(config: ProjectConfig) {
  if (pg.canRun && from !== undefined) {
    // Someone else's code (a share link, a GitHub repo) loads into the editor but runs only on the reader's Run click.
    log("sys", `[open] ${from} is from a link. Review it, then press Run.`);
    session.setStatus({ state: "idle", text: "Opened from a link. Review, then Run." });
  } else if (pg.canRun) {
    // The runner installs before each run itself.
    if (pg.missingDeps() && pg.runtime.current() === "browser") await install();
    if (config.autorun === false) session.setStatus({ state: "idle", text: "Ready" });
    else await run();
  }
}
await begin(applyConfig());
Object.assign(window, { vfs, semver: pg.semver });
