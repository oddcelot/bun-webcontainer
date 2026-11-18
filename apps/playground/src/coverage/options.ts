// `bun test --coverage`'s options, from the command line and bunfig.toml's `[test]` table, as Bun reads them
// (bunfig/bunfig.rs, runtime/cli/Arguments.rs): the page reads them to know whether to instrument (moduleServer.ts),
// the worker to report (worker/coverage.ts).

export type CoverageOptions = {
  enabled: boolean;
  reporters: { text: boolean; lcov: boolean };
  /** Where lcov.info goes, from the working directory. */
  dir: string;
  /** Below these (0 to 1) a file fails; the run fails with it only when `coverageThreshold` was set. */
  thresholds: { functions: number; lines: number };
  failOnLow: boolean;
  skipTestFiles: boolean;
  ignorePatterns: string[];
};

/** The defaults of a release build of Bun. */
export const defaultCoverage = (): CoverageOptions => ({
  enabled: false,
  reporters: { text: true, lcov: false },
  dir: "coverage",
  thresholds: { functions: 0.9, lines: 0.9 },
  failOnLow: false,
  skipTestFiles: true,
  ignorePatterns: [],
});

/** The `bun test` flags about coverage that take a value. */
export const COVERAGE_VALUE_FLAGS = ["--coverage-reporter", "--coverage-dir"];

/** Whether `flag` (as `--name` or `--name=value`) is one of coverage's. */
export const isCoverageFlag = (flag: string) => flag === "--coverage" || COVERAGE_VALUE_FLAGS.some((f) => flag === f || flag.startsWith(`${f}=`));

/**
 * The options from bunfig.toml's parsed `[test]` table (`test`), then the flags (`--name=value` form). Throws Bun's
 * message for a value it rejects.
 */
export function coverageOptions(flags: string[], test: Record<string, unknown> | undefined): CoverageOptions {
  const o = defaultCoverage();
  const t = test ?? {};
  const bool = (key: string) => {
    const v = t[key];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new Error(`expected boolean but received ${typeof v} (bunfig.toml [test] ${key})`);
    return v;
  };
  o.enabled = bool("coverage") ?? false;
  const reporter = t.coverageReporter;
  if (reporter !== undefined) {
    o.reporters = { text: false, lcov: false };
    for (const r of (Array.isArray(reporter) ? reporter : [reporter]) as unknown[]) {
      if (r === "text" || r === "lcov") o.reporters[r] = true;
      else throw new Error(`Invalid coverage reporter "${String(r)}"`);
    }
  }
  if (typeof t.coverageDir === "string") o.dir = t.coverageDir;
  const threshold = t.coverageThreshold;
  if (typeof threshold === "number") {
    o.thresholds = { functions: threshold, lines: threshold };
    o.failOnLow = true;
  } else if (threshold && typeof threshold === "object") {
    const { functions, lines, statements } = threshold as Record<string, unknown>;
    if (typeof functions === "number") (o.thresholds.functions = functions), (o.failOnLow = true);
    if (typeof lines === "number") (o.thresholds.lines = lines), (o.failOnLow = true);
    if (typeof statements === "number") o.failOnLow = true;
  }
  o.skipTestFiles = bool("coverageSkipTestFiles") ?? o.skipTestFiles;
  const ignore = t.coveragePathIgnorePatterns;
  if (typeof ignore === "string") o.ignorePatterns = [ignore];
  else if (Array.isArray(ignore) && ignore.length) {
    if (!ignore.every((p) => typeof p === "string")) throw new Error("coveragePathIgnorePatterns array must contain only strings");
    o.ignorePatterns = ignore;
  } else if (ignore !== undefined && !Array.isArray(ignore)) throw new Error("coveragePathIgnorePatterns must be a string or array of strings");

  if (flags.includes("--coverage")) o.enabled = true;
  const reporters = flags.filter((f) => f.startsWith("--coverage-reporter=")).map((f) => f.slice(20));
  if (reporters.length) {
    o.enabled = true;
    o.reporters = { text: false, lcov: false };
    for (const r of reporters) {
      if (r === "text" || r === "lcov") o.reporters[r] = true;
      else throw new Error(`invalid coverage reporter '${r}'. Available options: 'text' (console output), 'lcov' (code coverage file)`);
    }
  }
  const dir = flags.filter((f) => f.startsWith("--coverage-dir=")).pop();
  if (dir) o.dir = dir.slice(15);
  return o;
}

/** Bun's test file names: `.test`, `_test`, `.spec` or `_spec` before the extension. */
export const isTestName = (path: string) => /(?:\.test|_test|\.spec|_spec)\.[^./]+$/.test(path);

/**
 * Whether a run with coverage counts in the file at VFS `path`, as Bun instruments (`BunTest__shouldGenerateCodeCoverage`):
 * JavaScript and TypeScript outside node_modules, test files only with `coverageSkipTestFiles = false`.
 */
export const isCovered = (path: string, opts: Pick<CoverageOptions, "skipTestFiles">) =>
  /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) && !/(?:^|\/)node_modules\//.test(path) && !(opts.skipTestFiles && isTestName(path));

/** The global array of a file's counters (`id`: fileId). */
export const counterName = (id: number) => `$__cov${id}`;

/** A 31-bit hash of a file's path: the name of its counters. */
export function fileId(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 0) & 0x7fffffff;
}
