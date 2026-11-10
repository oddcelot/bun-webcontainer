// The parts of Bun's test `harness` the shell tests use. Spawning a Bun (bunExe) skips the test.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { SkipError } from "./bun-test.ts";

export const bunEnv: Record<string, string | undefined> = { ...process.env };
/** A path no command has but run.ts's: a test that runs it (`${bunExe()} -e …`) is skipped. */
export const NATIVE_BUN = "/__native_bun__";
export const bunExe = () => NATIVE_BUN;
export const isWindows = false;
export const isPosix = true;
export const isLinux = process.platform === "linux";
export const isMacOS = process.platform === "darwin";
export const isMusl = false;
export const isRoot = false;
export const isDebug = false;
export const isASAN = false;
export const libcPathForDlopen = () => {
  throw new SkipError("bun:ffi");
};

type Tree = { [name: string]: string | Tree };
function fill(dir: string, files: Tree) {
  for (const [name, v] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof v === "string") writeFileSync(p, v);
    else {
      mkdirSync(p, { recursive: true });
      fill(p, v);
    }
  }
}
export function tmpdirSync(prefix = "bun-shell-") {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
export function tempDirWithFiles(prefix: string, files: Tree) {
  const dir = tmpdirSync(prefix + "-");
  fill(dir, files);
  return dir;
}
/** `using dir = tempDir(...)`: a path string with Symbol.dispose. */
export function tempDir(prefix: string, files: Tree = {}) {
  const dir = tempDirWithFiles(prefix, files);
  return Object.assign(new String(dir), { [Symbol.dispose]() {}, toString: () => dir, valueOf: () => dir }) as unknown as string & Disposable;
}
export const rss = () => process.memoryUsage.rss();
export const runWithErrorPromise = () => {
  throw new SkipError("spawns a native Bun");
};

// Bun's path functions take tempDir's String object; node's want a primitive.
for (const k of ["join", "resolve", "relative", "dirname", "basename"] as const) {
  const fn = path[k] as (...a: unknown[]) => string;
  (path as any)[k] = (...a: unknown[]) => fn(...a.map((x) => (x instanceof String ? String(x) : x)));
}
syncBuiltinESMExports();
