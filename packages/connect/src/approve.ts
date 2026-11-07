// The runner's terminal approves each playground page before its first run (server.ts `approve`). A web page can't
// answer here, so code that reached the runner on its own (a project's preview or program on the playground's origin)
// still needs the person at the terminal.
import { createInterface } from "node:readline";
import type { ApprovalRequest } from "./server.ts";

/** Asks in this terminal, one page at a time; refuses every page when there is no terminal to ask in. */
export function terminalApproval(): (request: ApprovalRequest) => Promise<boolean> {
  let queue = Promise.resolve(true);
  return (request) => {
    if (!process.stdin.isTTY) {
      console.warn(`refused a run from ${request.origin}: no terminal to ask in (start the runner in one, or pass --no-confirm)`);
      return Promise.resolve(false);
    }
    queue = queue.then(() => ask(request), () => ask(request));
    return queue;
  };
}

function describe(r: ApprovalRequest): string {
  const what = r.test ? `bun test ${r.test.join(" ")}` : r.entry ? `bun run ${r.entry}` : "bun install";
  const shown = r.files.slice(0, 5).join(", ") + (r.files.length > 5 ? `, … (${r.files.length} files)` : "");
  return `${what}  ·  ${shown}`;
}

async function ask(r: ApprovalRequest): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${r.origin} wants to run code on this machine:\n  ${describe(r)}`);
    const answer = await new Promise<string>((resolve) =>
      rl.question("Allow this page to run code here until it reloads? Say no if you didn't just press Run. [y/N] ", resolve),
    );
    const ok = /^y(es)?$/i.test(answer.trim());
    console.log(ok ? "allowed" : "refused");
    return ok;
  } finally {
    rl.close();
  }
}
