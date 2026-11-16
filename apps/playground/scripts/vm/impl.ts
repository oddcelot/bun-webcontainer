// cases.ts on the worker's node:vm (src/worker/node/vm.ts) under Bun, without a browser.
import vm from "../../src/worker/node/vm.ts";
import { run } from "./cases.ts";

run(vm as never, console.log);
