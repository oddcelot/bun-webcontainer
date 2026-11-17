/**
 * `bun install`'s lifecycle scripts, as Bun runs them (bun/src/install/lockfile/Package/Scripts.rs, lockfile.rs
 * `has_trusted_dependency`): the root's `preinstall` before the packages go in, then the scripts of each newly installed
 * package Bun trusts (`trustedDependencies`, else its default list), then the root's `install`, `postinstall` and
 * `prepare` scripts. A dependency's scripts that aren't trusted are skipped and counted ("Blocked 3 postinstalls"),
 * as `bun pm untrusted` lists them. Each script is a line in Bun's shell, in a worker of its own (runner.ts `exec`).
 */
import type { VFS } from "@runbun/vfs";
import { installPath, parseBunLock, resolutionKind, splitKey } from "./lockfile";
import { DEFAULT_TRUSTED } from "./defaultTrusted";
import { vfsWorkspaces } from "./workspaces";
import { BUN_VERSION } from "./worker/bunVersion";

type Log = (level: "log" | "error", text: string) => void;

/** Runs a shell line in `cwd` (`/` is the project) with `env`; resolves with its exit code. */
export type ScriptRunner = (script: string, cwd: string, env: Record<string, string>, out: (fd: 1 | 2, data: Uint8Array) => void, timeout: number) => Promise<{ code: number; signal: string | null }>;

/** How long one script may take: one that never ends (a server, a prompt) is ended rather than hold the install. */
export const SCRIPT_TIMEOUT = 120_000;

/** A dependency's install hooks; a git dependency's and the root's add the prepare ones (`get_script_entries`). */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;
const PREPARE_HOOKS = ["preprepare", "prepare", "postprepare"] as const;

/** Bun links these packages' native binary instead of running their postinstall (postinstall_optimizer.rs). */
const NATIVE_BINLINK = new Set(["esbuild", "@anthropic-ai/claude-code"]);

type Manifest = { name?: string; version?: string; workspaces?: string[] | { packages?: string[] }; scripts?: Record<string, string>; trustedDependencies?: string[]; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

/** A package of bun.lock that has scripts to run, where it is installed. */
export type Scripted = { key: string; name: string; kind: ReturnType<typeof resolutionKind>; /** What `bun pm untrusted` shows after `@`. */ version: string; dir: string; trusted: boolean; scripts: [string, string][] };

const parse = (text: string | undefined): Manifest | undefined => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as Manifest);
  } catch {}
};

/** Whether `bun install` trusts a package's scripts: `has_trusted_dependency` and `can_trust_by_name`. */
function trusts(root: Manifest, direct: Set<string>, alias: string, name: string, kind: string, registry: unknown): boolean {
  const list = root.trustedDependencies;
  if (Array.isArray(list)) {
    // An npm package by its own name; any other kind by the name it is installed under, if the root or a workspace depends on it.
    return kind === "npm" ? list.includes(name) : list.includes(alias) && direct.has(alias);
  }
  // Bun's own list: npm packages only, from npm's registry.
  return kind === "npm" && DEFAULT_TRUSTED.has(name) && !registry;
}

/**
 * The packages in `lockText` that have scripts `bun install` would run: their hooks in order (a package with a
 * binding.gyp and no install hook gets `node-gyp rebuild`), and whether it trusts them. Deepest first, so a package's
 * scripts run after those of its dependencies. `only`: the install paths to consider (those just installed).
 */
export function scriptedPackages(vfs: Pick<VFS, "readText" | "files">, lockText: string, only?: Set<string>): Scripted[] {
  const lock = parseBunLock(lockText);
  const root = parse(vfs.readText("package.json")) ?? {};
  const direct = new Set<string>();
  for (const m of [root, ...vfsWorkspaces(vfs, root).map((w) => w.manifest as Manifest)]) {
    for (const d of [m.dependencies, m.devDependencies, m.optionalDependencies]) for (const n of Object.keys(d ?? {})) direct.add(n);
  }
  const out: Scripted[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const ident = entry[0];
    if (typeof ident !== "string") continue;
    const at = ident.indexOf("@", 1);
    const name = ident.slice(0, at), res = ident.slice(at + 1);
    const kind = resolutionKind(res);
    if (kind === "workspace" || kind === "root") continue;
    const info = entry.find((e) => !!e && typeof e === "object" && !Array.isArray(e)) as { hasInstallScript?: boolean } | undefined;
    // npm packages say whether they have any (the registry's hasInstallScript); the others are read.
    if ((kind === "npm" || kind === "tarball") && !info?.hasInstallScript) continue;
    const names = splitKey(key);
    const dir = installPath(names);
    if (only && !only.has(dir)) continue;
    const m = parse(vfs.readText(`${dir}/package.json`));
    if (!m) continue;
    const s = m.scripts ?? {};
    const hooks: [string, string][] = [];
    if (!s.preinstall && !s.install && vfs.files.has(`${dir}/binding.gyp`)) hooks.push(["install", "node-gyp rebuild"]);
    for (const h of INSTALL_HOOKS) if (s[h]) hooks.push([h, s[h]]);
    if (kind === "git") for (const h of PREPARE_HOOKS) if (s[h]) hooks.push([h, s[h]]);
    if (!hooks.length) continue;
    const alias = names.at(-1)!;
    const npmLike = kind === "npm" ? (typeof entry[1] === "string" ? entry[1] : "") : undefined;
    out.push({ key, name, kind, version: kind === "npm" ? res : res.replace(/^file:/, ""), dir, trusted: trusts(root, names.length === 1 ? direct : new Set(), alias, name, kind, npmLike), scripts: hooks });
  }
  return out.sort((a, b) => b.dir.split("/node_modules/").length - a.dir.split("/node_modules/").length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The environment a script sees: npm's variables, and the bins of node_modules (the package's own first). */
function scriptEnv(event: string, script: string, dir: string, m: Manifest): Record<string, string> {
  const bins: string[] = [];
  for (let d = dir; ; d = d.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, "")) {
    bins.push(`/${d ? `${d}/` : ""}node_modules/.bin`);
    if (!d) break;
  }
  return {
    HOME: "/",
    INIT_CWD: "/",
    PATH: [...bins, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    npm_command: "install",
    npm_config_user_agent: `bun/${BUN_VERSION} npm/? node/v24.3.0 browser wasm`,
    npm_lifecycle_event: event,
    npm_lifecycle_script: script,
    npm_package_json: `/${dir ? `${dir}/` : ""}package.json`,
    ...(m.name ? { npm_package_name: m.name } : {}),
    ...(m.version ? { npm_package_version: m.version } : {}),
  };
}

/** What a failed script most likely needed: a native build can't happen in a browser tab. */
const nativeHint = (script: string) =>
  /node-gyp|prebuild-install|node-pre-gyp|cmake-js|napi-build|cargo |make\b/.test(script) ? " (it builds a native addon, which can't be done in the browser)" : "";

/**
 * Runs `hooks` of the package in `dir` (`""`: the root), one after the other. The root's and a workspace's are echoed
 * (`$ line`) with their output as it comes, as Bun does; a dependency's output only shows if it fails. Stops at the
 * first that fails and returns false.
 */
async function runHooks(run: ScriptRunner, vfs: Pick<VFS, "readText">, dir: string, label: string, hooks: [string, string][], echo: boolean, log: Log): Promise<boolean> {
  const m = parse(vfs.readText(dir ? `${dir}/package.json` : "package.json")) ?? {};
  for (const [event, script] of hooks) {
    if (echo) log("log", `$ ${script}`);
    const held: [1 | 2, string][] = [];
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    const rest = { 1: "", 2: "" };
    const out = (fd: 1 | 2, data: Uint8Array) => {
      const text = rest[fd] + decoders[fd].decode(data, { stream: true });
      const lines = text.split("\n");
      rest[fd] = lines.pop()!;
      if (!lines.length) return;
      if (echo) log(fd === 2 ? "error" : "log", lines.join("\n"));
      else held.push([fd, lines.join("\n")]);
    };
    const { code, signal } = await run(script, `/${dir}`, scriptEnv(event, script, dir, m), out, SCRIPT_TIMEOUT);
    for (const fd of [1, 2] as const) if (rest[fd]) (echo ? log(fd === 2 ? "error" : "log", rest[fd]) : held.push([fd, rest[fd]]));
    if (!code && !signal) continue;
    for (const [fd, text] of held) log(fd === 2 ? "error" : "log", text);
    if (signal === "SIGKILL" && code === 137) log("error", `error: ${event} script from "${label}" didn't finish within ${SCRIPT_TIMEOUT / 1000}s and was stopped`);
    else if (signal) log("error", `error: ${event} script from "${label}" terminated by ${signal}`);
    else log("error", `error: ${event} script from "${label}" exited with ${code}${nativeHint(script)}`);
    return false;
  }
  return true;
}

/** The root's (and the workspaces') scripts of one phase: `before` the packages are installed, or after. */
export async function runRootScripts(run: ScriptRunner, vfs: Pick<VFS, "readText" | "files">, phase: "before" | "after", log: Log): Promise<boolean> {
  const root = parse(vfs.readText("package.json")) ?? {};
  const pick = (m: Manifest, events: readonly string[]) => events.flatMap((e): [string, string][] => (m.scripts?.[e] ? [[e, m.scripts[e]]] : []));
  if (phase === "before") return runHooks(run, vfs, "", root.name ?? "root", pick(root, ["preinstall"]), true, log);
  // A workspace runs its install hooks and its `prepare`, before the root's own.
  for (const w of vfsWorkspaces(vfs, root)) {
    const m = w.manifest as Manifest;
    if (!(await runHooks(run, vfs, w.path, m.name ?? w.path, pick(m, [...INSTALL_HOOKS, "prepare"]), true, log))) return false;
  }
  return runHooks(run, vfs, "", root.name ?? "root", pick(root, ["install", "postinstall", ...PREPARE_HOOKS]), true, log);
}

/**
 * The trusted dependencies' scripts (deepest first) of the packages installed at `only`; the untrusted ones are
 * counted. Returns the scripts it blocked and whether all that ran succeeded.
 */
export async function runDependencyScripts(run: ScriptRunner, vfs: Pick<VFS, "readText" | "files">, lockText: string, only: Set<string> | undefined, log: Log): Promise<{ ok: boolean; blocked: number }> {
  let blocked = 0;
  for (const p of scriptedPackages(vfs, lockText, only)) {
    if (!p.trusted) {
      blocked += p.scripts.length;
      continue;
    }
    // Bun links these packages' binaries instead (or ignores the script): none is for the browser anyway.
    if (NATIVE_BINLINK.has(p.name) || (p.name === "sharp" && p.kind === "npm" && /^0\.(3[3-9]|[4-9]\d)\.|^[1-9]/.test(p.version))) continue;
    if (!(await runHooks(run, vfs, p.dir, p.name, p.scripts, false, log))) return { ok: false, blocked };
  }
  return { ok: true, blocked };
}

/** `Blocked 3 postinstalls. Run \`bun pm untrusted\` for details.` */
export const blockedMessage = (n: number) => `Blocked ${n} postinstall${n === 1 ? "" : "s"}. Run \`bun pm untrusted\` for details.`;

/** `bun pm untrusted`: the installed packages whose scripts weren't run, with them, as Bun lists them. */
export function untrustedReport(vfs: Pick<VFS, "readText" | "files">): string {
  const lock = vfs.readText("bun.lock");
  const list = lock === undefined ? [] : scriptedPackages(vfs, lock).filter((p) => !p.trusted);
  if (!list.length) return `Found 0 untrusted dependencies with scripts.\n\nThis means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts.\n\nFor more information, visit https://bun.com/docs/install/lifecycle#trusteddependencies`;
  const blocks = [...list].sort((a, b) => (a.dir < b.dir ? -1 : 1)).map((p) => `./${p.dir} @${p.version}\n${p.scripts.map(([e, s]) => ` » [${e}]: ${s}`).join("\n")}`);
  return `${blocks.join("\n\n")}\n\nThese dependencies had their lifecycle scripts blocked during install.\n\nIf you trust them and wish to run their scripts, use \`bun pm trust\`.`;
}

/** The names `bun pm trust` adds to trustedDependencies: those given that have blocked scripts, or all (`--all`). */
export function untrustedNames(vfs: Pick<VFS, "readText" | "files">): string[] {
  const lock = vfs.readText("bun.lock");
  if (lock === undefined) return [];
  return [...new Set(scriptedPackages(vfs, lock).filter((p) => !p.trusted).map((p) => (p.kind === "npm" ? p.name : p.key.split("/").pop()!)))];
}
