import { BASE } from "../base";
import type { VFS } from "@runbun/vfs";
import { runWasi } from "./wasi";

// `git` in the console: gitoxide (gix) compiled to wasm32-wasip1 (crates/git-wasm), a WASI command run once per
// invocation against the project's files, its WASI calls served from the VFS (wasi.ts). Loaded on first use.

let compiled: Promise<WebAssembly.Module> | undefined;
const dec = new TextDecoder();

export type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Runs `git <args>` over `vfs` (the project root is the repository's worktree). */
export async function git(vfs: VFS, args: string[], { colors = true } = {}): Promise<GitResult> {
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
  return { exitCode, stdout: text(out), stderr: text(err) };
}
