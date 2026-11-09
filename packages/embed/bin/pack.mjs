#!/usr/bin/env node
// runbun-embed pack: builds an example library for <bun-playground library="…"> (protocol.ts Library) from a folder
// of projects laid out like github.com/oddcelot/runbun-examples: one folder per project, each with an example.json
// (name, description, kind, tags, order; or repo) and its files. Text files only; node_modules, .git and build
// output are left out.
//
//   bunx @runbun/embed pack ./examples > public/runbun/library.json
//   npx @runbun/embed pack ./examples --out public/runbun/library.json --open hello
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const USAGE = `usage: runbun-embed pack <dir> [--out <file>] [--open <id>]

Builds a library for <bun-playground library="…"> from <dir>: one folder per project (its id), each with an
example.json ({ "name", "description", "kind": "starter" | "example", "tags": [...], "order"?, "repo"? }).`;

const SKIP = new Set(["node_modules", ".git", "dist", ".astro", ".DS_Store", "example.json"]);
/** Past this, a project is likely to carry something it shouldn't (a build, a database). */
const BIG = 512 * 1024;
const KINDS = ["starter", "example"];

const [command, ...rest] = process.argv.slice(2);
if (command !== "pack" || !rest.length || rest.includes("--help") || rest.includes("-h")) {
  console.error(USAGE);
  process.exit(command === "pack" ? 1 : 2);
}
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest.splice(i, 2)[1] : undefined;
};
const out = flag("--out") ?? flag("-o");
const open = flag("--open");
const dir = rest[0];
if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`not a folder: ${dir}\n\n${USAGE}`);
  process.exit(1);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
let problems = 0;
const warn = (msg) => {
  problems++;
  console.error(`warning: ${msg}`);
};

/** Every text file under `root`, by path relative to it. */
function filesOf(root, at = root, files = {}) {
  for (const name of readdirSync(at).sort()) {
    if (SKIP.has(name)) continue;
    const path = join(at, name);
    if (statSync(path).isDirectory()) filesOf(root, path, files);
    else {
      const rel = relative(root, path).split("\\").join("/");
      try {
        files[rel] = decoder.decode(readFileSync(path));
      } catch {
        warn(`${relative(dir, path)} isn't UTF-8 text: left out`);
      }
    }
  }
  return files;
}

const projects = [];
for (const id of readdirSync(dir).sort()) {
  const folder = join(dir, id);
  const metaPath = join(folder, "example.json");
  if (!statSync(folder).isDirectory() || !existsSync(metaPath)) continue;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    warn(`${id}/example.json doesn't parse (${e.message}): left out`);
    continue;
  }
  if (typeof meta.name !== "string" || !meta.name) {
    warn(`${id}/example.json has no name: left out`);
    continue;
  }
  const project = { id, name: meta.name };
  if (typeof meta.description === "string") project.description = meta.description;
  if (KINDS.includes(meta.kind)) project.kind = meta.kind;
  if (Array.isArray(meta.tags)) project.tags = meta.tags.filter((t) => typeof t === "string");
  if (typeof meta.repo === "string") project.repo = meta.repo;
  else {
    project.files = filesOf(folder);
    if (!Object.keys(project.files).length) {
      warn(`${id} has no files: left out`);
      continue;
    }
    const size = Object.values(project.files).reduce((n, text) => n + text.length, 0);
    if (size > BIG) warn(`${id} is ${Math.round(size / 1024)} KB of text; a library is read whole when the page loads`);
  }
  projects.push([project, typeof meta.order === "number" ? meta.order : Infinity]);
}

projects.sort(([a, ao], [b, bo]) => KINDS.indexOf(a.kind ?? "example") - KINDS.indexOf(b.kind ?? "example") || ao - bo || a.name.localeCompare(b.name));
const library = { projects: projects.map(([p]) => p) };
if (open) {
  if (library.projects.some((p) => p.id === open)) library.open = open;
  else warn(`--open ${open}: no such project`);
}
if (!library.projects.length) {
  console.error(`no projects in ${dir} (folders with an example.json)`);
  process.exit(1);
}

const json = JSON.stringify(library);
if (out) writeFileSync(out, json + "\n");
else process.stdout.write(json + "\n");
console.error(`${library.projects.length} projects, ${Math.round(json.length / 1024)} KB${out ? ` → ${out}` : ""}${problems ? `, ${problems} warning${problems === 1 ? "" : "s"}` : ""}`);
