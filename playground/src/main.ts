import "virtual:uno.css";
import { BASE } from "./base";
import { seedDemo } from "./demo";
import { examples, loadExample, repoExamples } from "./examples";
import { loadRepo, parseRepo } from "./github";
import { createPierre } from "./editors/pierre";
import { bunInstall } from "./install";
import { Runner } from "./runner";
import { mountFileTree } from "./fileTree";
import { mountPreview } from "./preview";
import { loadSemver } from "./semver";
import { showUnsupported, supportsMemory64 } from "./support";
import { VFS } from "./vfs";

// A different name on every visit.
const titles = ["Bun playground", "Bun Away", "Always Bunning", "Bun and Done", "Hot Cross Bun", "Bun in the Oven", "Bun Shot", "Bundle of Joy", "Bun Voyage", "On the Bun"];
document.title = document.getElementById("title")!.textContent = titles[Math.floor(Math.random() * titles.length)];

if (!supportsMemory64()) {
  showUnsupported();
  // Stop here without an error: nothing below can work, and the page already explains why.
  await new Promise<never>(() => {});
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const consoleEl = $("console");
const statusEl = $("status");

function log(level: string, text: string) {
  const line = document.createElement("div");
  line.className = level;
  line.textContent = text;
  consoleEl.append(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
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
const params = new URLSearchParams(location.search);
const exampleName = params.get("example") ?? "";
const repoParam = params.get("repo") ?? "";
const repo = repoParam ? parseRepo(repoParam) : null;
if (repoParam && !repo) log("error", `[github] not a GitHub repo: ${repoParam}`);
if (!(repo ? await loadRepo(vfs, repo, log) : exampleName && (await loadExample(vfs, exampleName)))) seedDemo(vfs);

/** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
function openProject(value: string) {
  const url = new URL(location.href);
  url.searchParams.delete("example");
  url.searchParams.delete("repo");
  if (value.startsWith("repo:")) url.searchParams.set("repo", value.slice(5));
  else if (value) url.searchParams.set("example", value);
  location.assign(url);
}

const exampleSelect = $<HTMLSelectElement>("example");
for (const [name, label] of Object.entries(examples)) exampleSelect.add(new Option(label, name));
for (const [name, label] of Object.entries(repoExamples)) exampleSelect.add(new Option(label, `repo:${name}`));
const selected = repoParam ? `repo:${repoParam}` : exampleName;
if (repoParam && !(repoParam in repoExamples)) exampleSelect.add(new Option(`GitHub: ${repoParam}`, selected));
exampleSelect.value = repoParam || exampleName in examples ? selected : "";
exampleSelect.onchange = () => openProject(exampleSelect.value);
$("openrepo").onclick = () => {
  const input = prompt("GitHub repo (owner/repo, owner/repo@ref or a github.com URL)", repoParam || "oddcelot/bun-elysia-demo");
  if (input) openProject(`repo:${input.trim()}`);
};
await setupServiceWorker();
const semver = await loadSemver();
const runner = new Runner(vfs, log);

let current = "index.ts";
const editorEl = $("editor");
const editor = createPierre(editorEl);

function openFile(path: string) {
  current = path;
  const data = vfs.read(path);
  editor.open(path, typeof data === "string" ? data : null, (text) => {
    if (current === path) vfs.write(path, text);
  });
  fileTree.reveal(path);
}

const fileTree = mountFileTree($("tree"), vfs, (path) => {
  if (path !== current) openFile(path);
});

vfs.onChange(({ path, created }) => {
  if (!created && path === current) {
    const d = vfs.read(path);
    if (typeof d === "string") editor.update(d);
  }
});

function entryFile(): string {
  try {
    const pkg = JSON.parse(vfs.readText("package.json") ?? "{}") as { module?: string; main?: string; scripts?: Record<string, string> };
    // `"dev": "bun --watch src/dev.ts"`: the file a `bun [flags] <file>` script runs.
    const script = (s?: string) => s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*(?:run\s+)?(\S+\.[cm]?[jt]sx?)\b/)?.[1];
    for (const e of [pkg.module, pkg.main, script(pkg.scripts?.dev), script(pkg.scripts?.start)])
      if (e && vfs.files.has(e.replace(/^\.\//, ""))) return e.replace(/^\.\//, "");
  } catch {}
  return ["index.ts", "index.tsx", "index.js", "src/index.ts"].find((f) => vfs.files.has(f)) ?? "index.ts";
}

async function run() {
  const btn = $<HTMLButtonElement>("run");
  btn.disabled = true;
  statusEl.textContent = "starting...";
  const entry = entryFile();
  log("sys", `[run] ${entry}`);
  await runner.start(entry);
  preview.reload();
  statusEl.textContent = "running";
  btn.disabled = false;
}

async function install() {
  const btn = $<HTMLButtonElement>("install");
  btn.disabled = true;
  statusEl.textContent = "installing...";
  log("sys", "[bun install]");
  try {
    const n = await bunInstall(vfs, semver, log);
    log("sys", `[bun install] ${n} packages installed`);
  } catch (e) {
    log("error", String(e));
  }
  statusEl.textContent = "";
  btn.disabled = false;
}

const preview = mountPreview();
$("run").onclick = run;
$("install").onclick = install;
$("clear").onclick = () => consoleEl.replaceChildren();
$("openfolder").onclick = () => $("folderinput").click();
$<HTMLInputElement>("folderinput").onchange = async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (!files.length) return;
  runner.stop();
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
  (e.target as HTMLInputElement).value = "";
  fileTree.reset();
  log("sys", `[open] ${files[0].webkitRelativePath.split("/")[0] || "files"}: ${n} files (node_modules skipped)`);
  openFile(entryFile());
};
$("newfile").onclick = () => {
  const name = prompt("File path", "new.ts");
  if (!name) return;
  vfs.write(name, "");
  openFile(name);
};

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
if (missingDeps()) await install();
await run();
Object.assign(window, { vfs, semver });
