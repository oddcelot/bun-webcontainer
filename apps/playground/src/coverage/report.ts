// The coverage report of `bun test --coverage`, as Bun writes it (runtime/cli/test_command.rs, sourcemap_jsc/
// CodeCoverage.rs): the text table on stderr and coverage/lcov.info, from the counters of instrument.ts.
import type { CoverageOptions } from "./options";
import type { CoverageMeta } from "./instrument";

/** A file the run loaded: its path from the working directory, its counters and what they count; `url` is what Bun sorts by. */
export type CoveredFile = { path: string; url?: string; counters: ArrayLike<number>; meta: CoverageMeta };

type Report = {
  path: string;
  /** Per executable line (0-based, ascending): its count. */
  lines: [number, number][];
  functions: number;
  functionsHit: number;
};

function report(f: CoveredFile): Report {
  const count = (c: number) => f.counters[c] ?? 0;
  const lines = f.meta.lines.map(([line, ...counters]): [number, number] => [line, Math.max(...counters.map(count))]);
  let functions = 0;
  let functionsHit = 0;
  for (const [c, parent] of f.meta.fns) {
    if (!count(parent)) continue; // never compiled: JSC didn't see it
    functions++;
    if (count(c)) functionsHit++;
  }
  return { path: f.path, lines, functions, functionsHit };
}

const fraction = (hit: number, all: number) => (all ? hit / all : 1);

/** Bun's `pretty_fmt` tags. */
const TAGS: Record<string, string> = { r: "\x1b[0m", d: "\x1b[2m", b: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m" };
const pretty = (s: string, colors: boolean) => s.replace(/<(\/?)(r|d|b|red|green)>/g, (_, close: string, tag: string) => (colors && !close ? TAGS[tag] : ""));

/** `{:>7.2}` of a percentage. */
const percent = (v: number) => (v * 100).toFixed(2).padStart(7);

/**
 * The text table (with Bun's colors if `colors`) and lcov.info's text of `files`, in Bun's order (by path), without
 * those `ignored` matches; `failing` when a file is below the thresholds.
 */
export function coverageReport(files: CoveredFile[], opts: CoverageOptions, ignored: (path: string) => boolean, colors: boolean): { table?: string; lcov?: string; failing: boolean } {
  const reports = files
    .filter((f) => !ignored(f.path))
    .map((f) => ({ ...f, url: f.url ?? f.path }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map(report);
  const fractions = reports.map((r) => {
    const functions = fraction(r.functionsHit, r.functions);
    const lines = fraction(r.lines.filter(([, n]) => n > 0).length, r.lines.length);
    return { functions, lines, failing: functions < opts.thresholds.functions || lines < opts.thresholds.lines };
  });
  const failing = fractions.some((f) => f.failing);
  const out: { table?: string; lcov?: string; failing: boolean } = { failing };
  const p = (s: string) => pretty(s, colors);

  if (opts.reporters.text) {
    const width = Math.max(9, ...reports.map((r) => r.path.length));
    const avg = { functions: 0, lines: 0 };
    for (const f of fractions) (avg.functions += f.functions), (avg.lines += f.lines);
    const avgThresholds = fractions.length ? opts.thresholds : { functions: 0, lines: 0 };
    if (fractions.length) (avg.functions /= fractions.length), (avg.lines /= fractions.length);
    const separator = p("<r><d>") + "-".repeat(width + 2) + p("|---------|---------|-------------------<r>\n");
    const values = (name: string, indent: boolean, v: { functions: number; lines: number }, t: { functions: number; lines: number }, failed: boolean) =>
      (colors ? p(failed ? "<r><b><red>" : "<r><b><green>") : "") +
      (indent ? " " : "") +
      name +
      " ".repeat(width - name.length + (indent ? 0 : 1)) +
      p("<r><d> | <r>") +
      (colors ? p(v.functions < t.functions ? "<b><red>" : "<b><green>") : "") +
      percent(v.functions) +
      p("<r><d> | <r>") +
      (colors ? p(v.lines < t.lines ? "<b><red>" : "<b><green>") : "") +
      percent(v.lines);
    let table = separator + "File" + " ".repeat(width - 4 + 1) + p(" <d>|<r> % Funcs <d>|<r> % Lines <d>|<r> Uncovered Line #s\n") + separator;
    table += values("All files", false, avg, avgThresholds, failing) + p("<r><d> |<r>\n");
    for (const [i, r] of reports.entries()) {
      table += values(r.path, true, fractions[i], opts.thresholds, fractions[i].failing) + p("<r><d> | <r>");
      // Runs of executable lines that didn't run: "5-6,17".
      const runs: [number, number][] = [];
      for (const [line] of r.lines.filter(([, n]) => n === 0)) {
        const last = runs.at(-1);
        if (last && line === last[1] + 1) last[1] = line;
        else runs.push([line, line]);
      }
      table += runs.map(([a, b]) => p("<red>") + (a === b ? `${a + 1}` : `${a + 1}-${b + 1}`)).join(p("<r><d>,<r>")) + "\n";
    }
    out.table = table + separator;
  }

  if (opts.reporters.lcov) {
    let lcov = "";
    for (const r of reports) {
      lcov += `TN:\nSF:${r.path.replace(/[\r\n]/g, "?")}\nFNF:${r.functions}\nFNH:${r.functionsHit}\n`;
      for (const [line, n] of r.lines) lcov += `DA:${line + 1},${n}\n`;
      lcov += `LF:${r.lines.length}\nLH:${r.lines.filter(([, n]) => n > 0).length}\nend_of_record\n`;
    }
    out.lcov = lcov;
  }
  return out;
}
