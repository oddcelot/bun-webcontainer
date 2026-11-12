// What `persist` saves of an embed's project (src/persist.ts mirror, `generated`): the host's generated files never reach
// the saved copy, not with the first save of every file, not when the host writes them again, and not from the
// sessionStorage stash a reload cut off. A saved copy would come back over the host's newer one after a deploy.
// The reader's files save as before. Run with bun: `bun scripts/persist-skip.ts`. Exits 1 on a mismatch.
import { mirror } from "../src/persist.ts";
import { VFS } from "@runbun/vfs";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

/** An in-memory FileSystemDirectoryHandle: as much of one as `mirror` writes with. */
function memDir(files = new Map<string, unknown>(), prefix = ""): FileSystemDirectoryHandle {
  const notFound = () => new DOMException("not found", "NotFoundError");
  const dir = {
    kind: "directory",
    async getDirectoryHandle(name: string) {
      return memDir(files, `${prefix}${name}/`);
    },
    async getFileHandle(name: string, { create = false } = {}) {
      const path = prefix + name;
      if (!create && !files.has(path)) throw notFound();
      return {
        kind: "file",
        async createWritable() {
          return { write: async (d: unknown) => void files.set(path, d), close: async () => {} };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(prefix + name)) throw notFound();
    },
    async *[Symbol.asyncIterator]() {},
    files,
  };
  return dir as unknown as FileSystemDirectoryHandle;
}
const saved = (d: FileSystemDirectoryHandle) => Object.fromEntries([...(d as unknown as { files: Map<string, unknown> }).files].sort());

// The page's globals mirror() listens on and stashes in.
const store = new Map<string, string>();
Object.assign(globalThis, {
  document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  addEventListener() {},
  removeEventListener() {},
  sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});
const settle = () => new Promise((r) => setTimeout(r, 400));

const vfs = new VFS();
vfs.write("index.ts", "reader");
vfs.write("check.test.ts", "host v2");
// Unsaved edits from before a reload, a stale copy of the check among them.
store.set("stash", JSON.stringify({ "check.test.ts": "host v1", "draft.ts": "unsaved" }));
const dir = memDir();
const generated = (p: string) => p === "check.test.ts";
const stop = mirror(dir, vfs, () => {}, { all: true, generated, stash: "stash", tag: "[test]", where: "browser" });
await settle();
eq("the first save leaves the generated file out", saved(dir), { "draft.ts": "unsaved", "index.ts": "reader" });
eq("the stash doesn't bring back an old copy", vfs.readText("check.test.ts"), "host v2");

vfs.write("check.test.ts", "host v3");
vfs.write("index.ts", "reader, edited");
await settle();
eq("a later write isn't saved either; the reader's is", saved(dir), { "draft.ts": "unsaved", "index.ts": "reader, edited" });
await stop();

// Without `generated`, as for every project before it: everything is saved.
const all = memDir();
const stopAll = mirror(all, vfs, () => {}, { all: true, tag: "[test]", where: "browser" });
await settle();
await stopAll();
eq("without generated, every file", Object.keys(saved(all)), ["check.test.ts", "draft.ts", "index.ts"]);

if (bad) process.exit(1);
console.log("persist skip: ok");
