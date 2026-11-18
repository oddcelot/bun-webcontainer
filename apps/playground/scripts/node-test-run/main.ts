// `bun test` as a child process, and node:test's run(), which runs each file in one.
import { relative } from "node:path";
import { run } from "node:test";

console.log("__start__");

/** What a `bun test` printed that has to agree: its results and totals (no timings, no error excerpts). */
const kept = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/ \[[\d.]+m?s\]$/, ""))
    .filter((l) => /^\((pass|fail|skip|todo)\) /.test(l) || /^ \d+ (pass|fail|skip|todo)$/.test(l) || /^Ran \d+ tests? across/.test(l) || /^[\w.]+\.test\.ts:$/.test(l))
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
