// The bun.lock the playground writes for a project without one (src/lockfileWrite.ts) against the one native
// `bun install --lockfile-only` writes, on the projects in scripts/lockfile-write/. Needs the network (registry.npmjs.org).
// Then native `bun install --frozen-lockfile` must accept ours. A project with a package.changed.json then gets that
// as its package.json, and the bun.lock the playground updates from the first must be the one native Bun updates it to.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedPackages, resolveProject, writeBunLock, type Manifest, type ResolveHost } from "../src/lockfileWrite";

const fixtures = new URL("./lockfile-write/", import.meta.url).pathname;

function untar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break;
    const str = (a: number, b: number) => dec.decode(h.subarray(a, b)).split("\0")[0];
    const size = parseInt(str(124, 136).trim() || "0", 8);
    off += 512;
    out.set(str(0, 100), buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

function host(dir: string): ResolveHost {
  return {
    semver: { order: (a, b) => Bun.semver.order(a, b), satisfies: (v, r) => Bun.semver.satisfies(v, r) },
    async packument(name) {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      return res.json();
    },
    async tarball(url) {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const files = untar(Bun.gunzipSync(bytes));
      const pkg = [...files].find(([n]) => /^[^/]+\/package\.json$/.test(n));
      return { bytes, manifest: JSON.parse(new TextDecoder().decode(pkg![1])) };
    },
    async version(name, version) {
      return (await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`)).json();
    },
    folder(path) {
      const file = join(dir, path, "package.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : undefined;
    },
    packageDirs() {
      const out: string[] = [];
      const walk = (rel: string) => {
        for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
          else if (e.name === "package.json" && rel) out.push(rel);
        }
      };
      walk("");
      return out;
    },
  };
}

/** bun.lock is JSON with trailing commas. */
const parseLock = (text: string) => JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));

/** Ours and native Bun's bun.lock for the project in `dir`, `locked`: the bun.lock both start from. */
async function both(dir: string, locked?: string): Promise<[string, string, string[]]> {
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  const resolved = await resolveProject(root, host(dir), locked ? lockedPackages(parseLock(locked).packages) : []);
  const native = Bun.spawnSync(["bun", "install", "--lockfile-only", "--ignore-scripts"], { cwd: dir, stderr: "pipe" });
  if (native.exitCode) throw new Error(`native bun install: ${native.stderr}`);
  return [writeBunLock(resolved), readFileSync(join(dir, "bun.lock"), "utf8"), resolved.problems];
}

function report(label: string, dir: string, ours: string, theirs: string): boolean {
  if (ours === theirs) return true;
  writeFileSync(join(dir, "ours.lock"), ours);
  const diff = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "bun.lock", "ours.lock"], { cwd: dir });
  console.log(`${label}: DIFFERS from bun install's bun.lock\n${diff.stdout.toString().split("\n").slice(4, 60).join("\n")}`);
  return false;
}

let failed = 0;
for (const name of readdirSync(fixtures)) {
  const dir = mkdtempSync(join(tmpdir(), `lockfile-${name}-`));
  try {
    cpSync(join(fixtures, name), dir, { recursive: true });
    const [ours, theirs, problems] = await both(dir);
    if (problems.length) console.log(`${name}: problems: ${problems.join("; ")}`);
    if (!report(name, dir, ours, theirs)) {
      failed++;
      continue;
    }
    const frozen = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, stderr: "pipe" });
    if (frozen.exitCode) throw new Error(`bun install --frozen-lockfile refused it: ${frozen.stderr}`);
    console.log(`${name}: identical to bun install's bun.lock; --frozen-lockfile accepts it`);
    if (!existsSync(join(dir, "package.changed.json"))) continue;
    cpSync(join(dir, "package.changed.json"), join(dir, "package.json"));
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    const [ours2, theirs2] = await both(dir, theirs);
    if (report(`${name} (changed)`, dir, ours2, theirs2)) console.log(`${name} (changed): updates bun.lock as bun install does`);
    else failed++;
  } catch (e) {
    failed++;
    console.log(`${name}: ${e instanceof Error ? e.message : e}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (failed) {
  console.log(`${failed} project(s) differ`);
  process.exit(1);
}
