// What a command line runs in the project: a package.json script's file, an installed package's bin, the entry Run
// starts. Pure over two lookups, so the console (shell.ts) and spawned processes (worker/processes.ts) agree.
import { readConfig } from "./projectConfig";

export type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** `"dev": "bun --watch src/dev.ts"`: the file a `bun [flags] <file>` script runs. */
export const scriptEntry = (s?: string) =>
  s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*(?:run\s+)?(\S+\.[cm]?[jt]sx?)\b/)?.[1]?.replace(/^\.\//, "");

/** Whether a package.json script runs its file with `bun --check` (or `bun run --check`): type-checked first. */
export const scriptChecks = (s?: string) => /\s--check\b/.test(s?.match(/^bun\s+(?:(?:run\s+)?--?[\w-]+(?:=\S+)?\s+)*/)?.[0].replace(/^bun/, " ") ?? "");

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

/** Files `bun test` picks up: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`, outside node_modules. */
export const isTestFile = (path: string) => /(^|\/)[^/]+[._](test|spec)\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)node_modules\//.test(path);
