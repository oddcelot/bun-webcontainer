import type { Cookie } from "./cookieJar";
import { check as typeCheck, checkEntry } from "./check";
import { asConsoleEntry, fmt as formatFile, walks } from "./fmt";
import { clearPkgCache, fetchPackument, pkgCacheInfo } from "./pkgCache";
import { clearStore, storeInfo } from "./pkgStore";
import type { VFS } from "@runbun/vfs";
import { git as runGit } from "./git/git";
import { builtins } from "./shell/builtins";
import { EMPTY, Shell, ShellEnv, vfsFs, type Command as ShellCommand, type CommandCtx, type Writer } from "./shell/interp";
import { loadShellWasm } from "./shell/load";
import type { InstallFlags } from "./install";
import { untrustedNames, untrustedReport } from "./lifecycle";
import { links, setLink } from "./links";
import { makePatch, patchPath } from "./patches";
import { pristineFiles } from "./lockfile";
import { binCommand, cliPreloads, isTestFile, parseBunArgs, scriptChecks, scriptEntry, scriptPreloads, shellCommand, type Pkg } from "./scripts";
import { escape } from "./shell/dollar";

type Log = (level: string, text: string) => void;

/** What the console's commands drive: the same actions as the header buttons. */
export interface ShellHost {
  vfs: VFS;
  log: Log;
  /** Start the server on `entry` (the project's entry file when omitted), `args` after it in `process.argv`. */
  run(entry?: string, args?: string[]): Promise<void>;
  /** `bun install` (see install.ts InstallFlags). */
  install(options?: InstallFlags): Promise<void>;
  /** Run these test files (`bun test`); resolves with the number of failed tests. */
  test(files: string[], args?: string[]): Promise<{ failed: number }>;
  stop(): void;
  clear(): void;
  /** Forget this project's saved files and reload it from its source. */
  reset(): Promise<void>;
  /** Whether `git` is on (an embed's `git` feature); absent: always, as on the full playground. */
  git?: () => boolean;
  /** A `git` command ran: the Git panel reads the repository again. */
  gitRan?: () => void;
  /** What a network git command is doing (`Connecting to github.com`, `1.2 MB received`); null once it's done. */
  gitProgress?: (text: string | null) => void;
  /** The preview servers' cookies (absent when this browser can't run code). */
  cookies?: { list(): Promise<Readonly<Cookie>[]>; clear(): Promise<void> };
}

const HELP = `Bun's shell: quotes, pipes |, && || ;, redirects > >> < 2>&1, $VAR, x=1, $(cmd), globs *.ts, {a,b}, cd

bun run <script|file>  run a script or a file
bun <file>             run a file
bun test [-u] [filter...]  run test files (stops the server); -u updates snapshots
bun install, bun i     install dependencies
bun add <pkg> [-d]     add (dev) dependencies
bun remove <pkg>       remove dependencies
bun link [pkg]         register this folder's package, or depend on one registered (link:)
bun unlink             forget this folder's registration
bun patch <pkg>        patch an installed package: edit it, then bun patch --commit <folder>
bun install --ignore-scripts  install without running lifecycle scripts
bun pm cache [rm]      show or clear the package cache
bun pm untrusted       list the dependencies whose lifecycle scripts were blocked
bun pm trust <pkg>|--all  trust them: add to trustedDependencies and run their scripts
bun fmt [-c] [path...]  format (or --check) files like Prettier, with the project's configs
bun check [path...]    type check with Bun's TypeScript 7 checker (tsconfig.json, @types)
git <command>          init, status, add, commit, log, diff… (git help: all of them)
echo cd pwd ls cat touch mkdir rm mv cp seq yes which export exit true false dirname basename
clear  help
reset                  discard saved files, reload from source
cookies [clear]        list (or delete) the preview's cookies

↑/↓ history  Ctrl+C clear line or stop server
Ctrl+L clear console`;

/** Writes the console's way: whole lines, at a level (stdout "log", stderr "error"). */
function lineWriter(log: Log, level: string): Writer & { flush(): void } {
  const dec = new TextDecoder();
  let rest = "";
  return {
    async write(chunk) {
      rest += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop()!;
      if (lines.length) log(level, lines.join("\n"));
      return true;
    },
    flush() {
      if (rest) log(level, rest);
      rest = "";
    },
  };
}

export function createShell(host: ShellHost) {
  const { vfs } = host;
  /** Where the commands below write: the console, or a pipe or file while the shell redirects one (`run`). */
  let log: Log = host.log;
  /** Set when a command reported an error: its exit code is 1. */
  let failed = false;
  const fail = (text: string) => {
    failed = true;
    log("error", text);
  };

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
  const writePkg = (pkg: Pkg & Record<string, unknown>) => vfs.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

  /** `bun --check`: the type errors of `entry` and its imports, as Bun prints them; false if the program can't start. */
  async function checkFirst(entry: string): Promise<boolean> {
    const r = await checkEntry(vfs, entry);
    if (r.stderr.trim()) log(r.exitCode ? "error" : "warn", asConsoleEntry(r.stderr));
    if (r.exitCode) failed = true;
    return !r.exitCode;
  }

  /** `bun [run] [--check] <file or script>`. */
  async function runTarget(target: string | undefined, check = false) {
    if (!target) return host.run();
    const file = target.replace(/^\.\//, "");
    if (vfs.files.has(file)) return (!check || (await checkFirst(file))) && host.run(file);
    const script = readPkg()?.scripts?.[target];
    if (script === undefined) return fail(`error: Script not found "${target}"`);
    const entry = scriptEntry(script);
    const has = (path: string) => vfs.files.has(path);
    const bin = entry && has(entry) ? undefined : binCommand(script, has, (path) => vfs.readText(path));
    log("sys", `$ ${script}`);
    // `bun --preload ./p.ts main.ts`: a child `bun` of the shell's gets its flags (worker/processes.ts launchOf).
    if (!(entry && has(entry)) && !bin || scriptPreloads(script)) {
      const sh = shellCommand(script);
      return host.run(sh.entry, sh.args);
    }
    if (bin) return host.run(bin.entry, bin.args);
    return (!(check || scriptChecks(script)) || (await checkFirst(entry!))) && host.run(entry!);
  }

  /** The only `bun test` flag here: rewrite the snapshot files and inline snapshots (the playground's CI is never set). */
  const UPDATE_FLAGS = ["-u", "--update-snapshots"];
  async function test(args: string[]) {
    const flag = args.find((a) => a.startsWith("-") && !UPDATE_FLAGS.includes(a));
    if (flag) return fail(`error: bun test ${flag} is not supported here`);
    const filters = args.filter((a) => !a.startsWith("-")).map((a) => a.replace(/^\.\//, ""));
    const files = [...vfs.files.keys()].filter((f) => isTestFile(f) && (!filters.length || filters.some((x) => f.includes(x)))).sort();
    if (!files.length) return fail(`error: No tests found${filters.length ? ` matching ${filters.join(", ")}` : ""}!\n\nTest files match *.test.ts, *_test.ts, *.spec.ts or *_spec.ts (also .tsx .js .jsx), outside node_modules.`);
    await host.test(files, args.filter((a) => a.startsWith("-")));
  }

  async function add(args: string[]) {
    const dev = args.some((a) => a === "-d" || a === "-D" || a === "--dev");
    const specs = args.filter((a) => !a.startsWith("-"));
    if (!specs.length) return fail("usage: bun add <pkg[@range]>...");
    const pkg = readPkg();
    if (!pkg) return;
    const field = dev ? "devDependencies" : "dependencies";
    const ranges: Record<string, string> = {};
    for (const spec of specs) {
      const at = spec.indexOf("@", 1); // scoped names start with @
      const [name, range] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
      // `latest` and other tags go into package.json as `^x.y.z` of the version they point at (as Bun does), before
      // the install, so that bun.lock records the same range.
      if (/^[a-z][\w.-]*$/i.test(range)) {
        try {
          const doc = (await fetchPackument(name)) as { "dist-tags"?: Record<string, string> };
          const version = doc["dist-tags"]?.[range];
          if (!version) return fail(`error: ${name} has no version tagged "${range}"`);
          ranges[name] = `^${version}`;
        } catch (e) {
          return fail(`error: ${name}: ${e instanceof Error ? e.message : e}`);
        }
      } else ranges[name] = range;
    }
    writePkg({ ...pkg, [field]: { ...pkg[field], ...ranges } });
    await host.install();
    for (const name of Object.keys(ranges)) {
      const version = JSON.parse(vfs.readText(`node_modules/${name}/package.json`) ?? "{}").version;
      if (version) log("log", `installed ${name}@${version}`);
    }
  }

  async function pm([sub, action, ...more]: string[]) {
    if (sub === "untrusted") return log("log", untrustedReport(vfs));
    if (sub === "trust") return trust([action, ...more].filter((a) => a !== undefined));
    if (sub !== "cache") return fail(`bun pm ${sub ?? ""}: only "bun pm cache [rm]", "bun pm untrusted" and "bun pm trust" work here`);
    if (action === "rm") return await Promise.all([clearPkgCache(), clearStore()]), log("sys", "[bun pm cache] cleared");
    if (action) return fail(`bun pm cache: unknown option ${action}`);
    const [{ tarballs, packuments, bytes }, store] = await Promise.all([pkgCacheInfo(), storeInfo()]);
    const mb = (n: number) => (n / 2 ** 20).toFixed(1);
    log("log", `${tarballs} tarballs, ${packuments} manifests, ${mb(bytes)} MB in browser storage`);
    if (store.entries) log("log", `${store.entries} large package files, ${mb(store.bytes)} MB (unpacked on demand)`);
  }

  /**
   * `bun pm trust <names>` / `--all`: adds the dependencies whose scripts were blocked to trustedDependencies, then
   * installs, which runs their scripts (host.trusted) and writes the list to bun.lock.
   */
  async function trust(args: string[]) {
    const all = args.includes("--all");
    const blocked = untrustedNames(vfs);
    const names = all ? blocked : args.filter((a) => !a.startsWith("-"));
    if (!all && !names.length) return fail("error: expected package names(s) or --all");
    const unknown = names.filter((n) => !blocked.includes(n));
    if (!names.length || (unknown.length && unknown.length === names.length)) return fail(`error: 0 scripts ran. This means all dependencies are already trusted or none have scripts.`);
    const pkg = readPkg() as (Pkg & { trustedDependencies?: string[] }) | undefined;
    if (!pkg) return;
    const list = Array.isArray(pkg.trustedDependencies) ? pkg.trustedDependencies : [];
    writePkg({ ...pkg, trustedDependencies: [...list, ...names.filter((n) => !list.includes(n) && blocked.includes(n))] });
    await host.install({ trusted: names });
  }

  /**
   * `bun link` in a package's folder registers it (links.ts); `bun link <name>` depends on a registered one
   * (`"name": "link:name"`, always saved to package.json here) and installs it. `bun unlink` forgets the folder's.
   */
  async function link(args: string[], dir: string, unlink = false) {
    const names = args.filter((a) => !a.startsWith("-"));
    if (!names.length || unlink) {
      const pkg = vfs.readText(dir ? `${dir}/package.json` : "package.json");
      const name = (pkg && (JSON.parse(pkg) as { name?: string }).name) || undefined;
      if (!name) return fail(`error: ${pkg ? "package.json has no name" : `no package.json in /${dir}`}`);
      if (unlink) {
        if (links(vfs)[name] === undefined) return fail(`error: package "${name}" is not linked`);
        setLink(vfs, name, undefined);
        return log("log", `success: unlinked package "${name}"`);
      }
      setLink(vfs, name, dir);
      return log("log", `Success! Registered "${name}"\n\nTo use ${name} in a project, run:\n  bun link ${name}\n\nOr add it in dependencies in your package.json file:\n  "${name}": "link:${name}"`);
    }
    const registered = links(vfs);
    const missing = names.find((n) => registered[n] === undefined);
    if (missing) return fail(`error: package "${missing}" is not linked`);
    const pkg = readPkg();
    if (!pkg) return;
    writePkg({ ...pkg, dependencies: { ...pkg.dependencies, ...Object.fromEntries(names.map((n) => [n, `link:${n}`])) } });
    await host.install();
  }

  /**
   * `bun patch <pkg>`: says which folder to edit (installed files are the project's own here already).
   * `bun patch --commit <folder>`: the edits, as a patch from the package's own files (patches.ts), saved in
   * patches/ and named in package.json's patchedDependencies; the install then applies it as bun.lock records it.
   */
  async function patch(args: string[]) {
    const commit = args.includes("--commit");
    const dirFlag = args.find((a) => a.startsWith("--patches-dir="))?.slice("--patches-dir=".length);
    const target = args.find((a) => !a.startsWith("-"));
    if (!target) return fail(`error: missing package to patch: bun patch ${commit ? "--commit <folder>" : "<pkg>"}`);
    const dir = target.replace(/^\.\//, "").replace(/\/$/, "").startsWith("node_modules/") ? target.replace(/^\.\//, "").replace(/\/$/, "") : `node_modules/${target.replace(/(.)@[^/]*$/, "$1")}`;
    const meta = JSON.parse(vfs.readText(`${dir}/package.json`) ?? "null") as { name?: string; version?: string } | null;
    if (!meta?.name) return fail(`error: package ${target} not found`);
    if (!commit) return log("log", `\nTo patch ${meta.name}, edit the following folder:\n\n  ${dir}\n\nOnce you're done with your changes, run:\n\n  bun patch --commit '${dir}'`);
    const pristine = await pristineFiles(vfs, dir);
    if (!pristine) return fail(`error: ${meta.name} isn't a package installed from a tarball (bun.lock), so it can't be patched`);
    const paths = vfs.list(dir).filter((p) => !p.slice(dir.length + 1).split("/").includes("node_modules"));
    await vfs.ensure(paths);
    const edited = new Map(paths.flatMap((p) => {
      const bytes = vfs.readBytes(p);
      return bytes ? [[p.slice(dir.length + 1), bytes] as const] : [];
    }));
    const text = await makePatch(pristine, edited);
    if (!text) return log("log", `No changes detected in ${dir}`);
    const file = `${dirFlag ? dirFlag.replace(/\/$/, "") : "patches"}/${patchPath(meta.name, meta.version ?? "").slice("patches/".length)}`;
    vfs.write(file, text);
    const pkg = readPkg() as (Pkg & { patchedDependencies?: Record<string, string> }) | undefined;
    if (!pkg) return;
    writePkg({ ...pkg, patchedDependencies: { ...pkg.patchedDependencies, [`${meta.name}@${meta.version}`]: file } });
    await host.install();
  }

  async function remove(names: string[]) {
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
    // Like Bun, the lockfile follows: the install drops what nothing needs any more from bun.lock.
    if (vfs.files.has("bun.lock")) await host.install();
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

  /** `git …`: gitoxide over the project's files; see git/git.ts. */
  async function git(args: string[]) {
    let shown = false;
    const r = await runGit(vfs, args, {
      // clone, fetch, pull: what git is doing, in the status bar (git/git.ts GitProgress).
      onProgress: (p) => {
        shown = true;
        host.gitProgress?.(p.bytes && !p.text?.startsWith("Checking") && p.text !== "Updating files" ? `${(p.bytes / 1024 / 1024).toFixed(1)} MB received` : (p.text ?? ""));
      },
    }).finally(() => shown && host.gitProgress?.(null));
    host.gitRan?.();
    if (r.stdout) log("log", asConsoleEntry(r.stdout));
    // git writes hints and progress ("Switched to branch 'main'") to stderr too: an error only when it failed.
    if (r.stderr) log(r.exitCode ? "error" : "log", asConsoleEntry(r.stderr));
    // Its exit code is the command's, so `git commit … && git push` stops at a failed commit.
    if (r.exitCode) failed = true;
  }

  /** The console's terminal: what a command writes there shows at once, a line at a time. */
  const terminal = { out: lineWriter((l, t) => host.log(l, t), "log"), err: lineWriter((l, t) => host.log(l, t), "error") };

  /**
   * One of the console's own commands as a shell command: while it runs, `log` writes to its stdout and stderr, which
   * are the console itself (keeping its levels: warnings, the [sys] lines) unless the shell piped or redirected them.
   */
  const command =
    (fn: (args: string[], ctx: CommandCtx) => unknown): ShellCommand =>
    async (ctx) => {
      const before = { log, failed };
      const writes: Promise<unknown>[] = [];
      log = (level, text) => {
        const toErr = level === "error" || level === "warn";
        const w = toErr ? ctx.stderr : ctx.stdout;
        if (w === (toErr ? terminal.err : terminal.out)) {
          terminal.out.flush();
          terminal.err.flush();
          host.log(level, text);
        } else writes.push(w.write(text + "\n"));
      };
      failed = false;
      try {
        await fn(ctx.argv.slice(1), ctx);
        await Promise.all(writes);
        return failed ? 1 : 0;
      } catch (e) {
        fail(String(e));
        await Promise.all(writes);
        return 1;
      } finally {
        ({ log, failed } = before);
      }
    };

  /** `bun run <file>` from a folder: the file as the project names it. */
  const projectPath = (ctx: CommandCtx, p: string) => ctx.path(p).slice(1);

  const commands: Record<string, ShellCommand> = {
    help: command(() => log("log", HELP)),
    reset: command(() => host.reset()),
    cookies: command(([sub]) => cookies(sub)),
    clear: command(() => host.clear()),
    git: command((args) => (host.git?.() === false ? fail("git: off in this embed. Turn on Git in the ⋯ menu.") : git(args))),
    bun: command(async (args, ctx) => {
      // `bun --check <file>`, `bun run --check <file or script>`: type-check before running.
      const withCheck = args[0] === "--check" || (args[0] === "run" && args[1] === "--check");
      const [sub, ...rest] = args.filter((a, i) => !(a === "--check" && i <= 1));
      if (withCheck && sub !== "run" && (!sub || !vfs.files.has(projectPath(ctx, sub)))) return fail(`error: bun --check needs a file to run${sub ? `: "${sub}" not found` : ""}`);
      if (!sub || sub === "help" || sub === "--help") return log("log", HELP);
      // `bun -r ./p.ts main.ts`: run by the shell as a child process, which preloads them as Bun does.
      if (cliPreloads(parseBunArgs(args).execArgv).length) {
        const dir = ctx.path(".");
        const sh = shellCommand(`${dir === "/" ? "" : `cd ${escape(dir)} && `}${["bun", ...args].map(escape).join(" ")}`);
        return await host.run(sh.entry, sh.args);
      }
      if (sub === "test") return await test(rest);
      if (sub === "run") return await runTarget(rest[0] && vfs.files.has(projectPath(ctx, rest[0])) ? projectPath(ctx, rest[0]) : rest[0], withCheck);
      if (sub === "install" || sub === "i") return await host.install({ ignoreScripts: rest.includes("--ignore-scripts") });
      if (sub === "add" || sub === "a") return await add(rest);
      if (sub === "remove" || sub === "rm") return remove(rest);
      if (sub === "fmt") return await fmt(rest);
      if (sub === "check") return await check(rest);
      if (sub === "pm") return await pm(rest);
      if (sub === "patch") return await patch(rest);
      if (sub === "link" || sub === "unlink") return await link(rest, projectPath(ctx, "."), sub === "unlink");
      if (vfs.files.has(projectPath(ctx, sub))) return await runTarget(projectPath(ctx, sub), withCheck);
      fail(`bun ${sub}: not available here (try "help")`);
    }),
  };

  /** The shell's state between lines: `cd`, `export` and `x=1` last until the page reloads. */
  const env = new ShellEnv("/", new Map(), new Map([["HOME", "/"]]));
  let running: AbortController | undefined;

  async function exec(line: string) {
    let wasm;
    try {
      wasm = await loadShellWasm();
    } catch (e) {
      return host.log("error", `shell: couldn't load (${e})`);
    }
    let script;
    try {
      script = wasm.parse(line);
    } catch (e) {
      return host.log("error", `bun: ${(e as Error).message}`);
    }
    running = new AbortController();
    const shell = new Shell({ fs: vfsFs(vfs), wasm, builtins, commands, home: "/", signal: running.signal });
    try {
      await shell.run(script, { stdin: EMPTY, stdout: terminal.out, stderr: terminal.err }, env);
    } catch (e) {
      host.log("error", String(e));
    } finally {
      terminal.out.flush();
      terminal.err.flush();
      running = undefined;
    }
  }
  return Object.assign(exec, {
    /** Ctrl+C: stops the line that's running (`yes`, a long pipeline). */
    interrupt: () => running?.abort(),
    /** The shell's folder, for the prompt (`/` is the project). */
    cwd: () => env.cwd,
  });
}
