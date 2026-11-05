import "virtual:uno.css";
import { seedDemo } from "./demo";
import { examples, loadExample, repoExamples } from "./examples";
import { loadRepo, parseRepo, repoQuery } from "./github";
import { isShareLink, loadShareLink, rememberSource } from "./share";
import { createPlayground } from "./boot";
import { mountUI } from "./ui/mount";
import { attach, discard, mirror, readDir, restore, shareProjectId } from "./persist";
import { importZip } from "./archive";
import { canWrite, lastFolder, rememberFolder } from "./folders";
import { setThemeVars, urlVars } from "./theme";
import { showCanaryBadge } from "./canary";

showCanaryBadge();

const pg = createPlayground();
const { support, session, workspace, previews, terminal, vfs, log, run, stop, install, clearConsole, newFile, entryFile } = pg;
mountUI({ session, support, workspace, previews, terminal, clearConsole, vfs, log, run: () => run(), stop, install, openProject, newFile, openFolder, openDirectory, reopenFolder, openZip, repoParam: new URLSearchParams(location.search).get("repo") ?? "" });
const params = new URLSearchParams(location.search);
// ?vars= sets the overlay for this visit (theme.ts allows only that); not saved, and Share links drop it.
if (params.has("vars")) setThemeVars(urlVars(params.get("vars")));
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
const openFile = (path: string) => workspace.open(path);

async function reset() {
  // A write still in flight would recreate the directory after the discard.
  await stopSaving();
  if (projectId) await discard(projectId).catch((e) => log("error", `[storage] reset failed: ${e}`));
  location.reload();
}

await pg.start({ reset });

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
  await pg.clearProject();
  for (const [path, data] of files) vfs.write(path, data);
  // After the load: the files just read are on disk already.
  stopSaving = mirror(dir, vfs, log, { all: false, tag: "[folder]", watch: true });
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
  await pg.clearProject();
  for (const [path, data] of entries) vfs.write(path, data);
  workspace.reloadTree();
  log("sys", `[open] ${file.name}: ${entries.length} files (node_modules skipped)`);
  openFile(entryFile());
}


// `?folder=`: the folder opened before the reload, if the browser still lets us write to it; else it's a click away.
const folder = "showDirectoryPicker" in window ? await lastFolder() : undefined;
if (folder) session.setProject({ ...session.project(), reopen: folder.name });
if (params.has("folder")) {
  if (folder && (await canWrite(folder, false))) await openDirectory(folder);
  else log("sys", `[open] pick "Reopen ${folder?.name ?? params.get("folder")}" in the project menu to keep working on the folder`);
}

openFile(entryFile());
if (pg.canRun) {
  if (pg.missingDeps()) await install();
  await run();
}
Object.assign(window, { vfs, semver: pg.semver });
