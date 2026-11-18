// The environment the harnesses run native `bun` in: theirs without the variables that tell Bun an AI agent runs it.
// With one of them, `bun test` prints only failures, diffs as hunks with a line of context and names --cwd in its
// errors (bun_core's `Output::is_ai_agent`: AGENT=1, CLAUDECODE, REPL_ID; oxlint's list for `bun lint` is longer).
// The playground's users are people, so native Bun is compared as a person sees it, in a pipe.
const AGENT = /^(AGENT|AI_AGENT|CLAUDECODE|CLAUDE_CODE|REPL_ID|GEMINI_CLI|CODEX_SANDBOX|CODEX_THREAD_ID|COPILOT_CLI|OPENCODE|JUNIE_DATA|JUNIE_SHIM_PATH|CURSOR_AGENT)$/;

/** `process.env` without an agent's variables, then `extra` (an `undefined` value removes the variable). */
export function nativeEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT.test(k)));
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  else env[k] = v;
  return env;
}
