import type { Cookie } from "./cookieJar";
import { check as typeCheck } from "./check";
import { asConsoleEntry, fmt as formatFile, walks } from "./fmt";
import { clearPkgCache, pkgCacheInfo } from "./pkgCache";
import { clearStore, storeInfo } from "./pkgStore";
import type { VFS } from "@runbun/vfs";
import { readConfig } from "./projectConfig";
import { git as runGit } from "./git/git";

type Log = (level: string, text: string) => void;

/** What the console's commands drive: the same actions as the header buttons. */
export interface ShellHost {
  vfs: VFS;
  log: Log;
  /** Start the server on `entry` (the project's entry file when omitted), `args` after it in `process.argv`. */
  run(entry?: string, args?: string[]): Promise<void>;
  install(): Promise<void>;
  /** Run these test files (`bun test`); resolves with the number of failed tests. */
  test(files: string[]): Promise<number>;
  stop(): void;
  clear(): void;
  /** Forget this project's saved files and reload it from its source. */
  reset(): Promise<void>;
  /** Whether `git` is on (an embed's `git` feature); absent: always, as on the full playground. */
  git?: () => boolean;
  /** The preview servers' cookies (absent when this browser can't run code). */
  cookies?: { list(): Promise<Readonly<Cookie>[]>; clear(): Promise<void> };
}

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** `"dev": "bun --watch src/dev.ts"`: the file a `bun [flags] <file>` script runs. */
export const scriptEntry = (s?: string) =>
  s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*(?:run\s+)?(\S+\.[cm]?[jt]sx?)\b/)?.[1]?.replace(/^\.\//, "");

/** A file to run and the arguments it sees in `process.argv` after its own path. */
export type Command = { entry: string; args: string[] };

type Has = (path: string) => boolean;
type Read = (path: string) => string | undefined;

const parse = <T>(text: string | undefined): T | undefined => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {}
};

/** The file a package's bin `name` runs: `node_modules/<pkg>/…` of the package that declares it, if installed. */
function binFile(name: string, has: Has, read: Read): string | undefined {
  const root = parse<Pkg>(read("package.json"));
  const pkgs = [name, ...Object.keys({ ...root?.dependencies, ...root?.devDependencies })];
  for (const pkg of pkgs) {
    const meta = parse<{ name?: string; bin?: string | Record<string, string> }>(read(`node_modules/${pkg}/package.json`));
    const bin = meta?.bin;
    const file = typeof bin === "string" ? (pkg.split("/").pop() === name ? bin : undefined) : bin?.[name];
    const path = file && `node_modules/${pkg}/${file.replace(/^\.\//, "")}`;
    if (path && has(path)) return path;
  }
}

/** `"dev": "vite --port 3000"`: the bin a script calls and its arguments, for a plain command (no `&&`, pipes or env). */
export function binCommand(script: string | undefined, has: Has, read: Read): Command | undefined {
  if (!script || /[&|;<>$`()]|^\s*\w+=/.test(script)) return;
  const [name, ...args] = script.trim().split(/\s+/).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
  if (!name || name === "bun" || name === "node") return;
  const entry = binFile(name, has, read);
  return entry ? { entry, args } : undefined;
}

/**
 * What Run starts: package.json's module/main or a `bun <file>` dev/start script, else a dev/start script that calls
 * an installed package's bin (`"dev": "vite"`), else a usual index file.
 */
export function commandOf(has: Has, read: Read): Command {
  // runbun.json's `run` names it outright, when that file exists.
  const run = readConfig(read).run;
  if (run && has(run.entry)) return { entry: run.entry, args: run.args };
  const pkg = parse<{ module?: string; main?: string; scripts?: Record<string, string> }>(read("package.json")) ?? {};
  for (const e of [pkg.module, pkg.main, scriptEntry(pkg.scripts?.dev), scriptEntry(pkg.scripts?.start)])
    if (e && has(e.replace(/^\.\//, ""))) return { entry: e.replace(/^\.\//, ""), args: [] };
  const index = ["index.ts", "index.tsx", "index.js", "src/index.ts"].find(has);
  const bin = index ? undefined : (binCommand(pkg.scripts?.dev, has, read) ?? binCommand(pkg.scripts?.start, has, read));
  return bin ?? { entry: index ?? "index.ts", args: [] };
}

/**
 * The project's own file to open first: the one Run starts, else (a package's bin, or none found, as before an install)
 * index.html or package.json.
 */
export function entryOf(has: Has, read: Read): string {
  const { entry } = commandOf(has, read);
  if (has(entry) && !entry.startsWith("node_modules/")) return entry;
  return ["index.html", "package.json"].find(has) ?? entry;
}

/** A command line's words: split at whitespace; `"…"` and `'…'` keep spaces, a backslash escapes the next character. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | undefined; // undefined between words, so `""` still makes an (empty) word
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) out.push(word);
  return out;
}

/** Files `bun test` picks up: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, outside node_modules. */
export const isTestFile = (path: string) => /(^|\/)[^/]+[._](test|spec)\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)node_modules\//.test(path);

const HELP = `bun run <script|file>  run a script or a file
bun <file>             run a file
bun test [filter...]   run *.test.ts, *.spec.ts… (stops the server meanwhile)
bun install, bun i     install dependencies
bun add <pkg> [-d]     add (dev) dependencies
bun remove <pkg>       remove dependencies
bun pm cache [rm]      show (or clear) the package cache, shared by all projects
bun fmt [-c] [path...]  format (or --check) files like Prettier, with the project's configs
bun check [path...]    type check with Bun's TypeScript 7 checker (tsconfig.json, @types)
git <command>          init, status, add, commit, log, diff… (git help: all of them)
ls [dir]  cat <file>  clear  help
reset                  discard saved files, reload from source
cookies [clear]        list (or delete) the preview's cookies

↑/↓ history  Ctrl+C clear line or stop server
Ctrl+L clear console`;

export function createShell(host: ShellHost) {
  const { vfs, log } = host;
  const fail = (text: string) => log("error", text);

  async function cookies(sub?: string) {
    const jar = host.cookies;
    if (!jar) return fail("cookies: this browser can't run code");
    if (sub === "clear") return await jar.clear(), log("sys", "[cookies] cleared");
    if (sub) return fail(`cookies: unknown option ${sub}`);
    const all = await jar.list();
    if (!all.length) return log("log", "(no cookies)");
    for (const c of all) {
      const expires = c.expires === Infinity ? "session" : `expires ${new Date(c.expires).toISOString()}`;
      log("log", `${c.name}=${c.value}  path=${c.path}  ${expires}${c.httpOnly ? "  HttpOnly" : ""}`);
    }
  }

  function readPkg(): Pkg | undefined {
    try {
      return JSON.parse(vfs.readText("package.json") ?? "");
    } catch {
      fail("no package.json");
    }
  }
  const writePkg = (pkg: Pkg) => vfs.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

  async function runTarget(target: string | undefined) {
    if (!target) return host.run();
    const file = target.replace(/^\.\//, "");
    if (vfs.files.has(file)) return host.run(file);
    const script = readPkg()?.scripts?.[target];
    if (script === undefined) return fail(`error: Script not found "${target}"`);
    const entry = scriptEntry(script);
    const has = (path: string) => vfs.files.has(path);
    const bin = entry && has(entry) ? undefined : binCommand(script, has, (path) => vfs.readText(path));
    if (!(entry && has(entry)) && !bin) return fail(`error: only "bun <file>" scripts and installed packages' bins can run here: "${script}"`);
    log("sys", `$ ${script}`);
    return bin ? host.run(bin.entry, bin.args) : host.run(entry);
  }

  async function test(args: string[]) {
    const flag = args.find((a) => a.startsWith("-"));
    if (flag) return fail(`error: bun test ${flag} is not supported here`);
    const filters = args.map((a) => a.replace(/^\.\//, ""));
    const files = [...vfs.files.keys()].filter((f) => isTestFile(f) && (!filters.length || filters.some((x) => f.includes(x)))).sort();
    if (!files.length) return fail(`error: No tests found${filters.length ? ` matching ${filters.join(", ")}` : ""}!\n\nTest files match *.test.ts, *_test.ts, *.spec.ts or *_spec.ts (also .tsx .js .jsx), outside node_modules.`);
    await host.test(files);
  }

  async function add(args: string[]) {
    const dev = args.some((a) => a === "-d" || a === "-D" || a === "--dev");
    const specs = args.filter((a) => !a.startsWith("-"));
    if (!specs.length) return fail("usage: bun add <pkg[@range]>...");
    if (vfs.files.has("bun.lock")) return fail("error: bun add can't update bun.lock here; edit package.json and delete bun.lock first");
    const pkg = readPkg();
    if (!pkg) return;
    const field = dev ? "devDependencies" : "dependencies";
    const ranges: Record<string, string> = {};
    for (const spec of specs) {
      const at = spec.indexOf("@", 1); // scoped names start with @
      const [name, range] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
      ranges[name] = range;
    }
    writePkg({ ...pkg, [field]: { ...pkg[field], ...ranges } });
    await host.install();
    // `latest` and other tags: record what was installed, as `^x.y.z` (as Bun does).
    const after = readPkg();
    if (!after) return;
    for (const [name, range] of Object.entries(ranges)) {
      const version = JSON.parse(vfs.readText(`node_modules/${name}/package.json`) ?? "{}").version;
      if (!version) continue;
      if (!/^[\d^~<>=*]/.test(range)) after[field]![name] = `^${version}`;
      log("log", `installed ${name}@${version}`);
    }
    writePkg(after);
  }

  async function pm([sub, action]: string[]) {
    if (sub !== "cache") return fail(`bun pm ${sub ?? ""}: only "bun pm cache [rm]" is available here`);
    if (action === "rm") return await Promise.all([clearPkgCache(), clearStore()]), log("sys", "[bun pm cache] cleared");
    if (action) return fail(`bun pm cache: unknown option ${action}`);
    const [{ tarballs, packuments, bytes }, store] = await Promise.all([pkgCacheInfo(), storeInfo()]);
    const mb = (n: number) => (n / 2 ** 20).toFixed(1);
    log("log", `${tarballs} tarballs, ${packuments} manifests, ${mb(bytes)} MB in browser storage`);
    if (store.entries) log("log", `${store.entries} packages' large files unpacked, ${mb(store.bytes)} MB (read when a program needs them)`);
  }

  function remove(names: string[]) {
    if (!names.length) return fail("usage: bun remove <pkg>...");
    const pkg = readPkg();
    if (!pkg) return;
    for (const name of names) {
      const had = [pkg.dependencies, pkg.devDependencies].some((deps) => deps && name in deps && delete deps[name]);
      if (!had) {
        log("warn", `${name} is not in package.json`);
        continue;
      }
      vfs.remove(`node_modules/${name}`);
      log("log", `- ${name}`);
    }
    writePkg(pkg);
  }

  /**
   * `bun fmt [-c] [flags] [path...]` over the VFS. Each file goes through `bun fmt [flags] --stdin-filepath <file>`, so
   * the project's configs and bun fmt's own flags apply; folders are walked like bun fmt does (no node_modules, lock
   * files or minified code).
   */
  async function fmt(args: string[]) {
    let check = false;
    const flags: string[] = [];
    const targets: string[] = [];
    for (const a of args) {
      if (a === "-c" || a === "--check") check = true;
      else if (a.startsWith("-")) flags.push(a);
      else {
        const path = a.replace(/^\.\/?/, "").replace(/\/$/, "");
        // `--print-width 100`: a word after a flag without `=` is its value unless it names a file or a folder.
        const prev = flags.at(-1);
        if (prev && !prev.includes("=") && !vfs.files.has(path) && !vfs.isDir(path)) flags[flags.length - 1] = `${prev}=${a}`;
        else targets.push(path);
      }
    }
    const started = performance.now();
    const files = new Set<string>();
    for (const target of targets.length ? targets : [""]) {
      if (vfs.files.has(target)) {
        files.add(target);
        continue;
      }
      if (!vfs.isDir(target)) return fail(`error: No files matching the pattern were found: "${target}".`);
      for (const f of vfs.list(target)) {
        if (!/(^|\/)(node_modules|\.git)\//.test(f) && (await walks(vfs, f))) files.add(f);
      }
    }
    let changed = 0, same = 0, failed = 0;
    for (const f of [...files].sort()) {
      const text = vfs.readText(f);
      if (text === undefined) continue;
      const r = await formatFile(vfs, f, text, flags, true);
      // An error that doesn't name the file is about the command line (an unknown flag, a bad bunfig.toml): once is enough.
      if (r.exitCode && !r.stderr.includes(f)) return fail(asConsoleEntry(r.stderr));
      if (r.stderr) log(r.exitCode ? "error" : "warn", asConsoleEntry(r.stderr));
      if (r.exitCode) failed++;
      else if (r.stdout === text) same++;
      else {
        changed++;
        log("log", f);
        if (!check) vfs.write(f, r.stdout);
      }
    }
    const s = (n: number) => (n === 1 ? "file" : "files");
    if (check) {
      if (changed) log("warn", `${changed} ${s(changed)} need${changed === 1 ? "s" : ""} formatting. Run bun fmt to fix ${changed === 1 ? "it" : "them"}.`);
      else if (!failed) log("log", `${same} ${s(same)} ${same === 1 ? "is" : "are"} formatted.`);
      if (failed) fail(`Could not check ${failed} ${s(failed)}.`);
    } else log("log", `Formatted ${changed} ${s(changed)}, ${same} unchanged [${(performance.now() - started).toFixed(2)}ms]`);
  }

  /** `bun check [flags] [path...]`: Bun's type checker over the project, errors as it prints them. */
  async function check(args: string[]) {
    const r = await typeCheck(vfs, args);
    if (r.stdout) log(r.exitCode ? "error" : "log", asConsoleEntry(r.stdout));
    // The summary: "Found 2 errors in 1 file", "✓ No type errors in 3 files", a usage error.
    if (r.stderr.trim()) log(r.exitCode ? "error" : "log", asConsoleEntry(r.stderr));
  }

  function ls(dir = "") {
    const path = dir.replace(/^\.\/?/, "").replace(/\/$/, "");
    if (path && !vfs.isDir(path)) return vfs.files.has(path) ? log("log", path) : fail(`ls: ${dir}: No such file or directory`);
    const entries = vfs.readdir(path).sort((a, b) => a.name.localeCompare(b.name));
    log("log", entries.map((e) => (e.dir ? `\x1b[1;34m${e.name}/\x1b[0m` : e.name)).join("  "));
  }

  async function cat(file?: string) {
    if (!file) return fail("usage: cat <file>");
    const path = file.replace(/^\.\//, "");
    await vfs.ensure([path]);
    const text = vfs.readText(path);
    if (text === undefined) return fail(`cat: ${file}: No such file or directory`);
    for (const line of text.replace(/\n$/, "").split("\n")) log("log", line);
  }

  /** `git …`: gitoxide over the project's files; see git/git.ts. */
  async function git(args: string[]) {
    const r = await runGit(vfs, args);
    if (r.stdout) log("log", asConsoleEntry(r.stdout));
    // git writes hints and progress to stderr too: an error only when it failed.
    if (r.stderr) log(r.exitCode ? "error" : "warn", asConsoleEntry(r.stderr));
  }

  return async function exec(line: string) {
    const [cmd = "", ...args] = words(line);
    try {
      if (cmd === "help") return log("log", HELP);
      if (cmd === "reset") return await host.reset();
      if (cmd === "cookies") return await cookies(args[0]);
      if (cmd === "clear") return host.clear();
      if (cmd === "ls") return ls(args[0]);
      if (cmd === "cat") return await cat(args[0]);
      if (cmd === "git") return host.git?.() === false ? fail("git: off in this embed (turn on Git in the ⋯ menu)") : await git(args);
      if (cmd !== "bun") return fail(`${cmd}: command not found (try "help")`);
      const [sub, ...rest] = args;
      if (!sub || sub === "help" || sub === "--help") return log("log", HELP);
      if (sub === "test") return await test(rest);
      if (sub === "run") return await runTarget(rest[0]);
      if (sub === "install" || sub === "i") return await host.install();
      if (sub === "add" || sub === "a") return await add(rest);
      if (sub === "remove" || sub === "rm") return remove(rest);
      if (sub === "fmt") return await fmt(rest);
      if (sub === "check") return await check(rest);
      if (sub === "pm") return await pm(rest);
      if (vfs.files.has(sub.replace(/^\.\//, ""))) return await runTarget(sub);
      fail(`bun ${sub}: not available here (try "help")`);
    } catch (e) {
      fail(String(e));
    }
  };
}
