// `bun test` as a child process (its flags too), and node:test's run(), which runs each file in one.
import { readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { run } from "node:test";

console.log("__start__");

/**
 * What a `bun test` printed that has to agree: its results and totals, the first line of an error, what `--bail` and
 * `-t` say, the coverage table (no timings, no error excerpts).
 */
const kept = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/ \[[\d.]+m?s\]$/, ""))
    .filter(
      (l) =>
        /^\((pass|fail|skip|todo)\) /.test(l) ||
        /^ \d+ (pass|fail|skip|todo|filtered out|expect\(\) calls)$/.test(l) ||
        /^Ran \d+ tests? across/.test(l) ||
        /^[\w.]+\.test\.ts:( \(run #\d+\))?$/.test(l) ||
        /^ {2}\^ this test/.test(l) ||
        /^(error: |Bailed out after )/.test(l) ||
        /^-+\|/.test(l) ||
        /^ *\S.*\| +[\d.]+ \| +[\d.]+ \|/.test(l) ||
        /^File +\|/.test(l),
    )
    .map((l) => l.replace(/^(Ran .*?\.).*/, "$1"));

async function spawned(label: string, cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  console.log(`${label} exit: ${code}`);
  for (const l of out.split("\n")) if (l) console.log(`${label} stdout: ${l.replace(/^bun test v.*/, "bun test v")}`);
  for (const l of kept(err)) console.log(`${label} stderr: ${l}`);
}

await spawned("spawn", ["bun", "test", "a.test.ts"]);
await spawned("spawn ok", ["bun", "test", "./b.test.ts"]);
await spawned("script", ["bun", "run", "test"]);

// Its flags, as the console's `bun test` takes them.
await spawned("-t", ["bun", "test", "-t", "twice", "e.test.ts"]);
await spawned("-t describe", ["bun", "test", "--test-name-pattern=^math", "e.test.ts"]);
await spawned("-t skip", ["bun", "test", "-t", "skip|plain", "e.test.ts"]);
await spawned("-t none", ["bun", "test", "-t", "nomatch", "e.test.ts"]);
await spawned("--timeout", ["bun", "test", "--timeout", "20", "e.test.ts"]);
await spawned("--bail", ["bun", "test", "--bail", "e.test.ts"]);
await spawned("--bail=2", ["bun", "test", "--bail=2", "--timeout=20", "e.test.ts"]);
await spawned("--rerun-each", ["bun", "test", "--rerun-each", "2", "f.test.ts"]);
await spawned("--todo", ["bun", "test", "--todo", "e.test.ts"]);
await spawned(".only", ["bun", "test", "f.test.ts"]);
await spawned("--only", ["bun", "test", "--only", "e.test.ts", "f.test.ts"]);
await spawned("--coverage", ["bun", "test", "--coverage", "e.test.ts"]);
await spawned("--coverage lcov", ["bun", "test", "--coverage-reporter=lcov", "--coverage-dir", "cov", "e.test.ts"]);
console.log(`lcov: ${readFileSync("cov/lcov.info", "utf8").trim().split("\n").join(" ")}`);
rmSync("cov", { recursive: true, force: true });
for (const bad of [["--timeout", "x"], ["--bail=0"], ["--rerun-each", "-1"], ["-t", "("]]) await spawned(`bad ${bad.join(" ")}`, ["bun", "test", ...bad, "e.test.ts"]);

const stream = run({ files: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"] });
stream.on("data", (e: { type: string; data: Record<string, any> }) => {
  if (e.type === "test:stderr") return;
  const d = { ...e.data };
  if (e.type === "test:stdout" && /^bun test v/.test(d.message)) return;
  if (d.details) {
    const err = d.details.error;
    d.details = {
      ...d.details,
      duration_ms: typeof d.details.duration_ms,
      error: err && { message: err.failureType === "testCodeFailure" ? /broken file/.test(err.message) : err.message, name: err.name, code: err.code, failureType: err.failureType, cause: err.cause?.message, isError: err instanceof Error },
    };
  }
  if ("duration_ms" in d) d.duration_ms = typeof d.duration_ms;
  if (typeof d.message === "string" && d.message.startsWith("duration_ms")) d.message = "duration_ms X";
  if (typeof d.file === "string") d.file = relative(process.cwd(), d.file);
  console.log(`run: ${e.type} ${JSON.stringify(d)}`);
});
await new Promise((resolve) => stream.on("end", resolve));
console.log("__end__");
