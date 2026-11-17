// The entry both native Bun (`bun node-apis/main.ts`) and the playground run.
import { run } from "./cases.ts";

await run(console.log);
console.log("__end__");
process.exit(0);
