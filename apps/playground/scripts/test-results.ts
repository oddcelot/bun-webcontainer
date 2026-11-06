// `bun test`'s per-file counts (src/worker/node/test.ts runTestFiles), which the embed's `test` replies: a host grades
// each task by its own check file, so a failure has to count against the file it happened in, a file that doesn't
// load against itself, and the total stays the sum.
// Run with bun: `bun scripts/test-results.ts`. Exits 1 on a mismatch.
import bunTest, { runTestFiles } from "../src/worker/node/test.ts";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

const { test, expect, describe, afterAll } = bunTest;
/** What each file registers when it loads; a missing one fails to load. */
const files: Record<string, () => void> = {
  "a.test.ts": () => {
    test("passes", () => expect(1).toBe(1));
  },
  "b.test.ts": () => {
    test("fails", () => expect(1).toBe(2));
    describe("group", () => {
      test("fails too", () => expect("a").toBe("b"));
      test("passes", () => expect(true).toBe(true));
    });
  },
  "c.test.ts": () => {
    throw new Error("syntax error, say");
  },
  "d.test.ts": () => {
    test("passes", () => {});
    afterAll(() => {
      throw new Error("cleanup broke");
    });
  },
  "e.test.ts": () => {},
};

const quiet = { log: console.log, error: console.error };
console.log = console.error = () => {};
const outcome = await runTestFiles(Object.keys(files), async (f) => files[f]!(), "1.3.0");
// Run again: counts start over, they don't carry from the last run.
const again = await runTestFiles(["a.test.ts"], async (f) => files[f]!(), "1.3.0");
Object.assign(console, quiet);

eq("per file, in order", outcome.results, [
  { file: "a.test.ts", failed: 0 },
  { file: "b.test.ts", failed: 2 },
  { file: "c.test.ts", failed: 1 }, // didn't load
  { file: "d.test.ts", failed: 1 }, // its afterAll threw
  { file: "e.test.ts", failed: 0 }, // no tests
]);
eq("the total is the sum", outcome.failed, 4);
eq("a second run starts at zero", again, { failed: 0, results: [{ file: "a.test.ts", failed: 0 }] });

if (bad) process.exit(1);
console.log("test results: ok");
