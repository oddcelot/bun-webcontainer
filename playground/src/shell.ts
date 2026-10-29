import type { CookieJar } from "./cookieJar";
import type { VFS } from "./vfs";

type Log = (level: string, text: string) => void;

/** What the console's commands drive: the same actions as the header buttons. */
export interface ShellHost {
  vfs: VFS;
  log: Log;
  /** Start the server on `entry` (the project's entry file when omitted). */
  run(entry?: string): Promise<void>;
  install(): Promise<void>;
  stop(): void;
  clear(): void;
  /** Forget this project's saved files and reload it from its source. */
  reset(): Promise<void>;
  /** The preview servers' cookies (absent when this browser can't run code). */
  cookies?: CookieJar;
}

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** `"dev": "bun --watch src/dev.ts"`: the file a `bun [flags] <file>` script runs. */
export const scriptEntry = (s?: string) =>
  s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*(?:run\s+)?(\S+\.[cm]?[jt]sx?)\b/)?.[1]?.replace(/^\.\//, "");

const HELP = `bun run <script|file>  run a script or a file
bun <file>             run a file
bun install, bun i     install dependencies
bun add <pkg> [-d]     add (dev) dependencies
bun remove <pkg>       remove dependencies
ls [dir]  cat <file>  clear  help
reset                  discard saved files, reload from source
cookies [clear]        list (or delete) the preview's cookies

↑/↓ history  Ctrl+C clear line or stop server
Ctrl+L clear console`;

export function createShell(host: ShellHost) {
  const { vfs, log } = host;
  const fail = (text: string) => log("error", text);

  function cookies(sub?: string) {
    const jar = host.cookies;
    if (!jar) return fail("cookies: this browser can't run code");
    if (sub === "clear") return jar.clear(), log("sys", "[cookies] cleared");
    if (sub) return fail(`cookies: unknown option ${sub}`);
    const all = jar.list();
    if (!all.length) return log("log", "(no cookies)");
    for (const c of all) {
      const expires = c.expires === Infinity ? "session" : `expires ${new Date(c.expires).toISOString()}`;
      log("log", `${c.name}=${c.value}  path=${c.path}  ${expires}`);
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
    if (!entry || !vfs.files.has(entry)) return fail(`error: only "bun <file>" scripts can run here: "${script}"`);
    log("sys", `$ ${script}`);
    return host.run(entry);
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

  function ls(dir = "") {
    const path = dir.replace(/^\.\/?/, "").replace(/\/$/, "");
    if (path && !vfs.isDir(path)) return vfs.files.has(path) ? log("log", path) : fail(`ls: ${dir}: No such file or directory`);
    const entries = vfs.readdir(path).sort((a, b) => a.name.localeCompare(b.name));
    log("log", entries.map((e) => (e.dir ? `\x1b[1;34m${e.name}/\x1b[0m` : e.name)).join("  "));
  }

  function cat(file?: string) {
    if (!file) return fail("usage: cat <file>");
    const text = vfs.readText(file.replace(/^\.\//, ""));
    if (text === undefined) return fail(`cat: ${file}: No such file or directory`);
    for (const line of text.replace(/\n$/, "").split("\n")) log("log", line);
  }

  return async function exec(line: string) {
    const [cmd, ...args] = line.split(/\s+/);
    try {
      if (cmd === "help") return log("log", HELP);
      if (cmd === "reset") return await host.reset();
      if (cmd === "cookies") return cookies(args[0]);
      if (cmd === "clear") return host.clear();
      if (cmd === "ls") return ls(args[0]);
      if (cmd === "cat") return cat(args[0]);
      if (cmd !== "bun") return fail(`${cmd}: command not found (try "help")`);
      const [sub, ...rest] = args;
      if (!sub || sub === "help" || sub === "--help") return log("log", HELP);
      if (sub === "run") return await runTarget(rest[0]);
      if (sub === "install" || sub === "i") return await host.install();
      if (sub === "add" || sub === "a") return await add(rest);
      if (sub === "remove" || sub === "rm") return remove(rest);
      if (vfs.files.has(sub.replace(/^\.\//, ""))) return await runTarget(sub);
      fail(`bun ${sub}: not available here (try "help")`);
    } catch (e) {
      fail(String(e));
    }
  };
}
