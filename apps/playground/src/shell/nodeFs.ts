// The shell's files over a node-style fs: node's own in the conformance run (real temp dirs, as Bun's tests use),
// and the worker's node:fs, whose writes also reach the page's copy of the project.
import type { ShellFs } from "./interp";

/** The calls this needs from `node:fs`. */
export type NodeFsLike = {
  statSync(p: string): { isDirectory(): boolean; size: number; mtimeMs: number };
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(p: string): Uint8Array;
  writeFileSync(p: string, data: Uint8Array | string): void;
  mkdirSync(p: string, o: { recursive: true }): unknown;
  rmSync(p: string, o: { recursive: true; force: true }): void;
  renameSync(a: string, b: string): void;
  utimesSync(p: string, atime: number, mtime: number): void;
};

export function nodeFs(fs: NodeFsLike): ShellFs {
  // Paths arrive as String objects too (the conformance harness's tempDir), which node's fs refuses.
  const p = (x: string) => String(x);
  return {
    stat(path) {
      try {
        const st = fs.statSync(p(path));
        return { dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
      } catch {
        return undefined;
      }
    },
    readdir: (path) =>
      fs
        .readdirSync(p(path), { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    read: async (path) => new Uint8Array(fs.readFileSync(p(path))),
    write: (path, data) => fs.writeFileSync(p(path), data),
    mkdir: (path) => void fs.mkdirSync(p(path), { recursive: true }),
    remove: (path) => fs.rmSync(p(path), { recursive: true, force: true }),
    rename: (from, to) => fs.renameSync(p(from), p(to)),
    touch: (path, time) => fs.utimesSync(p(path), time / 1000, time / 1000),
  };
}
