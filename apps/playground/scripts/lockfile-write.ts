// The bun.lock the playground writes for a project without one (src/lockfileWrite.ts) against the one native
// `bun install --lockfile-only` writes, on the projects in scripts/lockfile-write/. Needs the network (registry.npmjs.org).
// Then native `bun install --frozen-lockfile` must accept ours. A project with a package.changed.json then gets that
// as its package.json, and the bun.lock the playground updates from the first must be the one native Bun updates it to.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNpmrc, registryFor } from "../src/npmrc";
import { lockedPackages, resolveProject, writeBunLock, type Manifest, type ResolveHost } from "../src/lockfileWrite";
import { tarballPath } from "../src/gitDeps";

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

function host(dir: string, seen: string[] = []): ResolveHost {
  const rc = parseNpmrc(existsSync(join(dir, ".npmrc")) ? readFileSync(join(dir, ".npmrc"), "utf8") : undefined);
  const get = async (url: string, headers?: Record<string, string>) => {
    seen.push(url);
    return fetch(url, { headers });
  };
  return {
    semver: { order: (a, b) => Bun.semver.order(a, b), satisfies: (v, r) => Bun.semver.satisfies(v, r) },
    async packument(name) {
      const res = await get(`${registryFor(rc, name)}/${name.replace("/", "%2f")}`, { accept: "application/vnd.npm.install-v1+json" });
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      return res.json();
    },
    async tarball(url) {
      const bytes = new Uint8Array(await (await get(url)).arrayBuffer());
      const files = untar(Bun.gunzipSync(bytes));
      const pkg = [...files].find(([n]) => /^[^/]+\/package\.json$/.test(n));
      return { bytes, manifest: JSON.parse(new TextDecoder().decode(pkg![1])) };
    },
    async version(name, version) {
      return (await get(`${registryFor(rc, name)}/${name.replace("/", "%2f")}/${version}`)).json();
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
    file(path) {
      const file = join(dir, path);
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
    },
    // The folders the project's bun-link.json lists, registered by `bun link` for native Bun too (in `nativeEnv`'s global folder).
    link(name) {
      const listed = existsSync(join(dir, "bun-link.json")) ? (JSON.parse(readFileSync(join(dir, "bun-link.json"), "utf8")) as string[]) : [];
      return listed.find((d) => existsSync(join(dir, d, "package.json")) && JSON.parse(readFileSync(join(dir, d, "package.json"), "utf8")).name === name);
    },
    // Straight from codeload: no CORS here, so no git proxy.
    async github(dep) {
      const url = `https://codeload.github.com/${tarballPath(dep)}`;
      seen.push(url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} - ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    gunzip: async (bytes) => Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>),
  };
}

/**
 * The environment native Bun runs in for the project in `dir`: with a bun-link.json, a global folder of its own
 * (BUN_INSTALL) where `bun link` registered each folder it lists, so the user's own links stay out of it.
 */
function nativeEnv(dir: string): Record<string, string | undefined> {
  if (!existsSync(join(dir, "bun-link.json"))) return process.env;
  const env = { ...process.env, BUN_INSTALL: join(dir, ".bun-global") };
  for (const d of JSON.parse(readFileSync(join(dir, "bun-link.json"), "utf8")) as string[]) {
    const r = Bun.spawnSync(["bun", "link"], { cwd: join(dir, d), env, stderr: "pipe" });
    if (r.exitCode) throw new Error(`bun link in ${d}: ${r.stderr}`);
  }
  return env;
}

/** bun.lock is JSON with trailing commas. */
const parseLock = (text: string) => JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));

/** Ours and native Bun's bun.lock for the project in `dir`, `locked`: the bun.lock both start from. */
async function both(dir: string, locked?: string, seen: string[] = []): Promise<[string, string, string[]]> {
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  const old = locked ? parseLock(locked) : undefined;
  const lockedRoot = old?.workspaces?.[""] ?? {};
  const lockedRanges = { ...lockedRoot.devDependencies, ...lockedRoot.optionalDependencies, ...lockedRoot.dependencies };
  const resolved = await resolveProject(root, host(dir, seen), old ? lockedPackages(old.packages) : [], lockedRanges);
  const native = Bun.spawnSync(["bun", "install", "--lockfile-only", "--ignore-scripts"], { cwd: dir, stderr: "pipe", env: nativeEnv(dir) });
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

// A registry other than npm's for the projects with an .npmrc (`__REGISTRY__` in it is this server, test-registry.ts: npm's
// own, relayed). A process of its own: native Bun is run with this one blocked.
const registry = Bun.spawn(["bun", new URL("./test-registry.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "inherit" });
const port = Number((await registry.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).match(/port (\d+)/)![1]);
const proxy = { port, stop: () => registry.kill() };

let failed = 0;
// `bun scripts/lockfile-write.ts [name...]`: only those projects.
const only = process.argv.slice(2);
for (const name of readdirSync(fixtures).filter((n) => !only.length || only.includes(n))) {
  const dir = mkdtempSync(join(tmpdir(), `lockfile-${name}-`));
  try {
    cpSync(join(fixtures, name), dir, { recursive: true });
    if (existsSync(join(dir, ".npmrc"))) writeFileSync(join(dir, ".npmrc"), readFileSync(join(dir, ".npmrc"), "utf8").replaceAll("__REGISTRY__", `http://localhost:${proxy.port}`));
    const seen: string[] = [];
    const [ours, theirs, problems] = await both(dir, undefined, seen);
    // Where we fetched from: a project's expected.json lists what must have come from the registry here (`here`) and
    // from npm's (`npm`), by package name.
    const expected = join(dir, "expected-registries.json");
    if (existsSync(expected)) {
      const { here = [], npm = [] } = JSON.parse(readFileSync(expected, "utf8")) as { here?: string[]; npm?: string[] };
      const from = (base: string, pkg: string) => seen.some((u) => u.startsWith(`${base}/${pkg.replace("/", "%2f")}`));
      for (const pkg of here) if (!from(`http://localhost:${proxy.port}`, pkg)) throw new Error(`${pkg} wasn't fetched from the project's registry`);
      for (const pkg of npm) if (!from("https://registry.npmjs.org", pkg)) throw new Error(`${pkg} wasn't fetched from npm`);
      rmSync(expected);
    }
    if (problems.length) console.log(`${name}: problems: ${problems.join("; ")}`);
    if (!report(name, dir, ours, theirs)) {
      failed++;
      continue;
    }
    const frozen = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dir, stderr: "pipe", env: nativeEnv(dir) });
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
proxy.stop();
if (failed) {
  console.log(`${failed} project(s) differ`);
  process.exit(1);
}
