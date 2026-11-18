// `bun test --coverage` in the worker: the files the run loads register their counters here (served ES modules
// through `__bwcCovFile`, CommonJS and synchronously run ES modules as worker/node/module.ts instruments them through
// `__bwcCoverage`), and once the tests are done the report is printed and written as Bun does (coverage/report.ts).
import type { CoverageMeta } from "../coverage/instrument";
import { counterName, fileId, isCovered, type CoverageOptions } from "../coverage/options";
import { coverageReport } from "../coverage/report";
import { insertColumns } from "../sourceMap";

type Hook = {
  /** Whether the file at VFS `path` counts. */
  covers(path: string): boolean;
  /** What transpiled `code` runs as instead, and its mappings; `script` for a function body, `source` a CommonJS file's. */
  instrument(path: string, code: string, mappings: string, source: string | undefined, script: boolean): [string, string];
};

const g = globalThis as unknown as { __bwcCovFile?: (id: number, url: string, meta: CoverageMeta) => void; __bwcCoverage?: Hook } & Record<string, unknown>;
/** By URL: `/<VFS path>`, or a runtime plugin's virtual module by its name (`ns:name`). */
const files = new Map<string, { counters: Float64Array; meta: CoverageMeta }>();

/** A loaded file's counters: those of an earlier load of the same text, which count on. */
function register(id: number, url: string, meta: CoverageMeta) {
  const name = counterName(id);
  const known = files.get(url);
  if (known && known.meta.n === meta.n) {
    g[name] = known.counters;
    return;
  }
  const counters = new Float64Array(meta.n);
  counters[0] = 1;
  g[name] = counters;
  files.set(url, { counters, meta });
}

/** Before the test files load: files register, and the instrumenter is there for those the worker runs itself. */
export async function startCoverage(opts: CoverageOptions): Promise<void> {
  const { instrument } = await import("../coverage/instrument");
  g.__bwcCovFile = register;
  g.__bwcCoverage = {
    covers: (path) => isCovered(path, opts),
    instrument(path, code, mappings, source, script) {
      const id = fileId(`/${path}`);
      const done = instrument(code, mappings, id, script, source);
      if (!done) return [code, mappings];
      register(id, `/${path}`, done.meta);
      return [done.code, insertColumns(mappings, done.inserts)];
    },
  };
}

/**
 * After the tests: the table (stderr, as `print`) and lcov.info (through `write`, at its path from the root), for files
 * under `cwd`; whether the run fails for it (a file below `coverageThreshold`).
 */
export function finishCoverage(opts: CoverageOptions, cwd: string, ignored: (path: string) => boolean, print: (text: string) => void, write: (path: string, text: string) => void): boolean {
  delete g.__bwcCovFile;
  delete g.__bwcCoverage;
  if (!files.size) return false;
  const relative = (url: string) => {
    if (!url.startsWith("/")) return url;
    const path = url.slice(1);
    if (!cwd) return path;
    if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
    return `${"../".repeat(cwd.split("/").length)}${path}`;
  };
  const covered = [...files].map(([url, f]) => ({ path: relative(url), url, ...f }));
  files.clear();
  const { table, lcov, failing } = coverageReport(covered, opts, ignored, true);
  if (table !== undefined) print(table.replace(/\n$/, ""));
  if (lcov !== undefined) write(`${cwd ? `${cwd}/` : ""}${opts.dir.replace(/^\.\/|\/$/g, "")}/lcov.info`, lcov);
  return failing && opts.failOnLow;
}
