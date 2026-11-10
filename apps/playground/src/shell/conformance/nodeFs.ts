// The shell's files over node's fs: the conformance run works on real temp dirs, as Bun's tests do.
import * as fs from "node:fs";
import type { ShellFs } from "../interp";

// Paths arrive as String objects too (the harness's tempDir), which node's fs refuses.
const raw: ShellFs = {
  stat(path) {
    try {
      const st = fs.statSync(path);
      return { dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch {
      return undefined;
    }
  },
  readdir(path) {
    return fs
      .readdirSync(path, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  },
  read: async (path) => new Uint8Array(fs.readFileSync(path)),
  write: (path, data) => fs.writeFileSync(path, data),
  mkdir: (path) => void fs.mkdirSync(path, { recursive: true }),
  remove: (path) => fs.rmSync(path, { recursive: true, force: true }),
  rename: (from, to) => fs.renameSync(from, to),
  touch: (path, time) => fs.utimesSync(path, time / 1000, time / 1000),
};

export const nodeFs: ShellFs = Object.fromEntries(
  Object.entries(raw).map(([k, fn]) => [k, (...a: unknown[]) => (fn as (...x: unknown[]) => unknown)(...a.map((x) => (x instanceof String ? String(x) : x)))]),
) as unknown as ShellFs;
