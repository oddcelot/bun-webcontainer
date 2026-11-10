import { BASE } from "../base";
import type { VFS } from "@runbun/vfs";
import { runWasi } from "./wasi";

// `git` in the console and the Git panel: gitoxide (gix) compiled to wasm32-wasip1 (crates/git-wasm), a WASI command
// run once per invocation against the project's files, its WASI calls served from the VFS (wasi.ts). Loaded on first use.

let compiled: Promise<WebAssembly.Module> | undefined;
const dec = new TextDecoder();

export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** What git wrote to stdout, undecoded (a blob that isn't text). */
  bytes: Uint8Array;
};

/** Whether git.wasm was fetched yet: nothing git-related loads until a command or the Git panel needs it. */
export let gitLoaded = false;

async function exec(vfs: VFS, args: string[], colors: boolean): Promise<GitResult> {
  gitLoaded = true;
  compiled ??= WebAssembly.compileStreaming(fetch(new URL(`${BASE}git.wasm`, location.href))).catch((e) => {
    compiled = undefined;
    throw e;
  });
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const { exitCode } = await runWasi(await compiled, vfs, {
    args: ["git", ...args],
    env: colors ? { GIT_COLOR: "1" } : {},
    stdout: (b) => out.push(b),
    stderr: (b) => err.push(b),
  });
  const text = (chunks: Uint8Array[]) => chunks.map((c) => dec.decode(c, { stream: true })).join("") + dec.decode();
  const bytes = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of out) {
    bytes.set(c, at);
    at += c.length;
  }
  return { exitCode, stdout: text(out), stderr: text(err), bytes };
}

/** Every command waits for the one before it: two instances over one VFS would race on .git/. */
let tail: Promise<unknown> = Promise.resolve();

/** Runs `git <args>` over `vfs` (the project root is the repository's worktree), after the commands queued before it. */
export function git(vfs: VFS, args: string[], { colors = true } = {}): Promise<GitResult> {
  const run = tail.then(() => exec(vfs, args, colors));
  tail = run.catch(() => {});
  return run;
}
