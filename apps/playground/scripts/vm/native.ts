// cases.ts on the real node:vm (Bun's, or Node's).
import vm from "node:vm";
import { run } from "./cases.ts";

run(vm, console.log);
