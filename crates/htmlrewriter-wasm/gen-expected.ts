// Writes expected.json: every case in cases.ts run on native Bun's HTMLRewriter (the pinned Bun, /.prototools).
import { writeFileSync } from "node:fs";
import { runCases } from "./cases.ts";

const results = await runCases(HTMLRewriter as never);
writeFileSync(new URL("./expected.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
console.log(`wrote ${Object.keys(results).length} cases (Bun ${Bun.version})`);
