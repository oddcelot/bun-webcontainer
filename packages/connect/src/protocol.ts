// Messages over the runner's WebSocket (/__connect/ws), JSON, one per frame.

/** A file's contents: text, or bytes as base64. */
export type FileData = string | { b64: string };

export type ClientMessage =
  | {
      t: "run";
      id: string;
      /** Runs of one project share a directory, so node_modules survives between runs. */
      project?: string;
      /** The project's files, relative paths. Files of the project's previous run that aren't here are deleted. */
      files: Record<string, FileData>;
      entry: string;
      args?: string[];
      /**
       * Environment variables for the program and its tests (the project's runbun.json `env`), under the runner's own;
       * names it doesn't take (its own, LD_*, DYLD_*) are left out. Runners older than it ignore it.
       */
      env?: Record<string, string>;
      /** `bun install` before the run (default: when there is a package.json). */
      install?: boolean;
      /** `bun test <files>` instead of `bun run <entry>`. An empty entry and no `test` only installs. */
      test?: string[];
      /**
       * A test run that wants its changed snapshots back (a `files` message): `true` adds `--update-snapshots`, `false`
       * only syncs (native Bun writes new snapshots without it). Runners older than it ignore the field and send no
       * `files`; `hello.features` says which kind this is.
       */
      updateSnapshots?: boolean;
      /**
       * A test run's coverage flags, passed on to `bun test`: `--coverage`, `--coverage-reporter=text|lcov`,
       * `--coverage-dir=<relative path>` (`coverageFlag` is the allowlist). bunfig.toml's `[test]` options go with the
       * project's files. Runners without `hello.features` "coverage" ignore it.
       */
      coverage?: string[];
      /**
       * The project's path of the lcov.info a coverage run writes (`<coverageDir>/lcov.info`), to send back in `files`
       * as it sends changed snapshots. Only with "coverage".
       */
      lcov?: string;
    }
  | { t: "stdin"; id: string; data: string }
  | { t: "kill"; id: string };

export type ServerMessage =
  /** features: what the runner can do beyond the first version; "snapshots" = it answers `updateSnapshots` with `files`. */
  | { t: "hello"; bun: string; platform: string; sandbox: string; features?: string[] }
  | { t: "started"; id: string; preview: string }
  | { t: "out"; id: string; fd: 1 | 2; data: string }
  /** phase: which step a line or exit belongs to; "approval": waiting for the runner's terminal to allow this page. */
  | { t: "phase"; id: string; phase: "approval" | "install" | "run" }
  /** The program accepts connections on its port (Bun.serve is up): previews can go to it. */
  | { t: "listening"; id: string }
  /**
   * Before a test run's `exit`, when the run had `updateSnapshots`: the files it changed, as text. Untrusted content
   * (the program under test wrote it): `syncPath` is the allowlist for both sides, `SYNC_LIMITS` the caps.
   */
  | { t: "files"; id: string; files: { path: string; text: string }[] }
  | { t: "exit"; id: string; code: number | null; signal: string | null }
  | { t: "error"; id?: string; message: string };

/**
 * Preview requests from the playground: the request's headers as JSON `[name, value][]` (fetch can't send Cookie),
 * and the response's `{ status, statusText, headers }` back (fetch can't read Set-Cookie, nor a redirect's Location;
 * the response itself is then a 200).
 */
export const PACKED_REQUEST = "x-runbun-headers";
export const PACKED_RESPONSE = "x-runbun-head";

/** GET /__connect/info, same-origin only: what a page served by the runner needs to connect. */
export interface ConnectInfo {
  ws: string;
  token: string;
  bun: string;
  sandbox: string;
}

/** Features the runner reports in `hello`. */
export const FEATURE_SNAPSHOTS = "snapshots";
/** It passes a test run's `coverage` flags to `bun test` and sends its `lcov` file back. */
export const FEATURE_COVERAGE = "coverage";

/**
 * A coverage flag the runner passes to `bun test` (`--name=value` form), or undefined: `--coverage`, a reporter Bun
 * knows, or a coverage directory inside the project.
 */
export function coverageFlag(flag: unknown): string | undefined {
  if (flag === "--coverage" || flag === "--coverage-reporter=text" || flag === "--coverage-reporter=lcov") return flag;
  if (typeof flag !== "string" || !flag.startsWith("--coverage-dir=")) return undefined;
  const dir = flag.slice(15).replace(/^\.\/+/, "").replace(/\/+$/, "");
  return dir === "" || dir === "." || syncPath(`${dir}/lcov.info`, [`${dir}/lcov.info`]) ? flag : undefined;
}

/** The lcov.info a page may ask back (`lcov`): `lcov.info` in a directory inside the project. */
export const lcovPath = (path: unknown): string | undefined =>
  typeof path === "string" && /(^|\/)lcov\.info$/.test(path) ? syncPath(path, [path]) : undefined;

/** What a `files` message may carry: per file, in all, and how many. The runner enforces them, and so does the page. */
export const SYNC_LIMITS = { file: 1024 * 1024, total: 8 * 1024 * 1024, count: 500 };

/**
 * The only paths a `files` message may carry: a `.snap` file directly in a `__snapshots__` directory, or one of the
 * run's test files (`tests`: the paths the page sent). Relative, no empty, `.` or `..` segments, no backslash or NUL,
 * nothing in node_modules or .git. Returns the path when allowed, else undefined.
 */
export function syncPath(path: unknown, tests: Iterable<string> = []): string | undefined {
  if (typeof path !== "string" || !path || path.length > 1024 || /[\\\0]/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === "node_modules" || p === ".git")) return undefined;
  const n = parts.length;
  if (n >= 2 && parts[n - 2] === "__snapshots__" && parts[n - 1]!.endsWith(".snap")) return path;
  for (const t of tests) if (t === path) return path;
  return undefined;
}
