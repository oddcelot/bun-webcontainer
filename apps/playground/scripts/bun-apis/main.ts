// Bun APIs the playground implements in JS, as one project both native Bun and the playground run (scripts/bun-apis.ts
// compares what they print): Bun.FileSystemRouter, Bun.stdout/stderr.writer(), runtime plugins (Bun.plugin).
import { plugins } from "./plugins.ts";
import { router } from "./router.ts";
import { stdout } from "./stdout.ts";

const log = (line: string) => console.log(line);
console.log("__start__");
await router(log);
await stdout(log);
await plugins(log);
console.log("__end__");
