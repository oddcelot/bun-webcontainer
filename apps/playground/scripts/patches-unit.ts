// src/patches.ts against git: the patch `bun patch --commit` writes (makePatch) is the `git diff --no-index --full-index`
// native Bun writes for the same edit, and applyPatchFile turns the package's files into the edited ones with it, with
// git's own patch and with ours. Needs git.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyPatchFile, makePatch } from "../src/patches";

const before: Record<string, string> = {
  "index.js": "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
  "lib/old.js": "module.exports = 'gone';\n",
  "empty.txt": "",
  "nonl.txt": "no newline",
};
const after: Record<string, string> = {
  "index.js": "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen",
  "lib/new.js": "module.exports = 'new';\nmore\n",
  "empty.txt": "filled\n",
  "nonl.txt": "no newline\n",
};

const tmp = mkdtempSync(join(tmpdir(), "patches-unit-"));
let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else (bad++, console.error(`✗ ${label}\n${detail}`));
};
try {
  const write = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(tmp, dir, p)), { recursive: true });
      writeFileSync(join(tmp, dir, p), t);
    }
  };
  write("old", before);
  write("new", after);
  // What Bun runs for `bun patch --commit` (bun/src/patch/lib.rs), from the folder above the two, and its paths
  // without the two folders (git_diff_postprocess).
  const git = Bun.spawnSync(["git", "-c", "core.safecrlf=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-cr-at-eol", "--irreversible-delete", "--full-index", "--no-index", "old", "new"], { cwd: tmp });
  let native = git.stdout.toString();
  for (const [from, to] of [["a/old/", "a/"], ["b/old/", "b/"], ["a/new/", "a/"], ["b/new/", "b/"]]) native = native.replaceAll(from, to);
  const enc = new TextEncoder();
  const map = (files: Record<string, string>) => new Map(Object.entries(files).map(([p, t]) => [p, enc.encode(t)]));
  const ours = (await makePatch(map(before), map(after)))!;
  check("makePatch writes git's diff", ours === native, `ours:\n${ours}\ngit:\n${native}`);
  for (const [label, patch] of [["git's patch", native], ["our patch", ours]] as const) {
    const files = { ...before };
    const failed = applyPatchFile({ readText: (p) => files[p], write: (p, d) => void (files[p] = d), remove: (p) => void delete files[p] }, patch);
    // A last newline added is no change to git (--ignore-cr-at-eol).
    const expected = { ...after, "nonl.txt": before["nonl.txt"] };
    check(`applyPatchFile applies ${label}`, !failed && JSON.stringify(Object.entries(files).sort()) === JSON.stringify(Object.entries(expected).sort()), failed ?? JSON.stringify(files, null, 1));
  }
  const conflict = applyPatchFile({ readText: () => "something else\n", write: () => {}, remove: () => {} }, ours);
  check("a patch that doesn't match is refused", typeof conflict === "string");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
