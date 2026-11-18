// What a command line runs in the project: a package.json script's file, an installed package's bin, the entry Run
// starts. Pure over two lookups, so the console (shell.ts) and spawned processes (worker/processes.ts) agree.
import { readConfig } from "./projectConfig";

export type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** Bun's flags (`bun --help`, `bun run --help`) that take the next word as their value unless given as `--flag=value`. */
const VALUE_FLAGS = new Set(
  "-r --preload --require --import -e --eval -p --print --port --conditions --main-fields --extension-order --tsconfig-override -d --define --drop --feature -l --loader --jsx-factory --jsx-fragment --jsx-import-source --jsx-runtime --env-file --cwd -c --config --console-depth --user-agent --title --redirect-warnings --disable-warning --unhandled-rejections --dns-result-order --max-http-header-size --fetch-preconnect --install --cpu-prof-name --cpu-prof-dir --cpu-prof-interval --heap-prof-name --heap-prof-dir --heap-prof-interval --elide-lines -F --filter --shell --watch-kill-signal --cron-title --cron-period".split(" "),
);
const PRELOAD_FLAGS = new Set(["-r", "--preload", "--require", "--import"]);

/** A `bun` command line (the words after `bun`): its flags before what it runs (`execArgv`), that and its arguments. */
export type BunArgs = { run: boolean; execArgv: string[]; target?: string; args: string[] };
export function parseBunArgs(words: string[]): BunArgs {
  const execArgv: string[] = [];
  let run = false;
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w === "run" && !run) run = true;
    else if (w.startsWith("-") && w !== "-") {
      execArgv.push(w);
      if (!w.includes("=") && VALUE_FLAGS.has(w) && i + 1 < words.length) execArgv.push(words[++i]!);
    } else break;
  }
  return { run, execArgv, target: words[i], args: words.slice(i + 1) };
}

/** The modules `--preload`/`-r` (`--require`, `--import`) name in a `bun` command's flags, in order. */
export function cliPreloads(execArgv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const [flag, value] = execArgv[i]!.split(/=(.*)/s);
    if (!PRELOAD_FLAGS.has(flag!)) continue;
    if (value !== undefined) out.push(value);
    else if (i + 1 < execArgv.length) out.push(execArgv[++i]!);
  }
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));

/** `"dev": "bun --watch src/dev.ts"`: the file a `bun [flags] <file>` script runs. */
export const scriptEntry = (s?: string) => {
  const [bun, ...rest] = s ? words(s) : [];
  if (bun !== "bun") return undefined;
  const target = parseBunArgs(rest).target;
  return target && /\.[cm]?[jt]sx?$/.test(target) ? target.replace(/^\.\//, "") : undefined;
};

/** Whether a `bun <file>` script preloads modules (`--preload`, `-r`): it runs through the shell, which passes them on. */
export const scriptPreloads = (s?: string) => {
  const [bun, ...rest] = s ? words(s) : [];
  return bun === "bun" && cliPreloads(parseBunArgs(rest).execArgv).length > 0;
};

/** Whether a package.json script runs its file with `bun --check` (or `bun run --check`): type-checked first. */
export const scriptChecks = (s?: string) => /\s--check\b/.test(s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*/)?.[0].replace(/^bun/, " ") ?? "");

/** A file to run and the arguments it sees in `process.argv` after its own path. */
export type Command = { entry: string; args: string[] };

export type Has = (path: string) => boolean;
export type Read = (path: string) => string | undefined;

const parse = <T>(text: string | undefined): T | undefined => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {}
};

/** The file a package's bin `name` runs: `node_modules/<pkg>/…` of the package that declares it, if installed. */
export function binFile(name: string, has: Has, read: Read): string | undefined {
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
  for (const [e, script] of [[pkg.module], [pkg.main], [scriptEntry(pkg.scripts?.dev), pkg.scripts?.dev], [scriptEntry(pkg.scripts?.start), pkg.scripts?.start]])
    if (e && has(e.replace(/^\.\//, ""))) return script && scriptPreloads(script) ? shellCommand(script) : { entry: e.replace(/^\.\//, ""), args: [] };
  const index = ["index.ts", "index.tsx", "index.js", "src/index.ts"].find(has);
  const bin = index ? undefined : (binCommand(pkg.scripts?.dev, has, read) ?? binCommand(pkg.scripts?.start, has, read));
  return bin ?? { entry: index ?? "index.ts", args: [] };
}

/**
 * The project's own file to open first: the one Run starts, else (a package's bin, or none found, as before an install)
 * index.html or package.json.
 */
export function entryOf(has: Has, read: Read): string {
  const command = commandOf(has, read);
  // A script run through the shell: the file its `bun` runs.
  const entry = isShellCommand(command.entry, command.args) ? (scriptEntry(command.args[1]) ?? command.entry) : command.entry;
  if (has(entry) && !entry.startsWith("node_modules/")) return entry;
  return ["index.html", "package.json"].find(has) ?? entry;
}

/**
 * What Run starts for a package.json script that is more than a file or a bin (`tsc && vite build`): Bun's shell
 * runs the line, its commands as child processes (worker/processes.ts). Entry and arguments, as `sh -c <line>`.
 */
export const shellCommand = (script: string): Command => ({ entry: "sh", args: ["-c", script] });
export const isShellCommand = (entry: string, args: string[]) => entry === "sh" && args[0] === "-c" && args.length >= 2;

/** Files `bun test` picks up: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, outside node_modules. */
export const isTestFile = (path: string) => /(^|\/)[^/]+[._](test|spec)\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)node_modules\//.test(path);
