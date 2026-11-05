// The worker's copy of the VFS follows the page's through its events, as the runner mirrors them (src/runner.ts):
// a file change writes or removes the file, a directory event makes it or removes it with everything below it.
// Run with bun: `bun scripts/vfs-mirror.ts`. Exits 1 on a mismatch.
import { VFS } from "@runbun/vfs";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

function mirrored() {
  const page = new VFS();
  const worker = new VFS();
  page.onChange(({ path, removed }) => (removed ? worker.remove(path) : worker.write(path, page.read(path)!)));
  page.onDir((path, removed) => (removed ? worker.remove(path) : worker.mkdir(path)));
  return { page, worker };
}
const state = (v: VFS) => ({ files: v.list(), dirs: [...v.dirs].sort() });

const cases: [string, string, string, string[]][] = [
  ["into its own subtree", "a", "a/b", ["a/x.ts", "a/s/y.ts"]],
  ["two levels down", "a", "a/b/c", ["a/x.ts"]],
  ["elsewhere", "a", "c", ["a/x.ts", "a/s/y.ts"]],
  ["a sibling sharing the prefix", "a", "ab", ["a/x.ts"]],
  ["up out of its parent", "a/b", "b", ["a/b/x.ts", "a/y.ts"]],
  ["a file", "a/x.ts", "a/y.ts", ["a/x.ts"]],
];
for (const [what, from, to, files] of cases) {
  const { page, worker } = mirrored();
  for (const f of files) page.write(f, f);
  page.rename(from, to);
  const moved = files.map((f) => (f === from || f.startsWith(from + "/") ? to + f.slice(from.length) : f)).sort();
  eq(`${what}: page files`, page.list(), moved);
  eq(`${what}: worker matches page`, state(worker), state(page));
  for (const f of moved) eq(`${what}: ${f} contents`, worker.readText(f), page.readText(f));
}

{
  const { page } = mirrored();
  page.write("a/x.ts", "");
  page.rename("a", "a/b");
  eq("no stray directories", [...page.dirs].sort(), ["a", "a/b"]);
}

if (bad) process.exit(1);
console.log("vfs mirror: ok");
