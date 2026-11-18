/**
 * `patchedDependencies` and `bun patch`: a git-style diff applied over an installed package's files, and the one
 * `bun patch --commit` makes from an edited package (bun/src/install/patch_install.rs; native Bun runs
 * `git diff --no-index --full-index` for it, here jsdiff does the diff).
 */
import { applyPatch, parsePatch, structuredPatch } from "diff";

/** A package folder's files, by their path in it. */
export type PackageFiles = { readText(path: string): string | undefined; write(path: string, data: string): void; remove(path: string): void };

const strip = (name: string | undefined) => (name === undefined || name === "/dev/null" ? undefined : name.replace(/^[ab]\//, ""));

/** Applies a patch file's diffs to `files`; returns why it doesn't apply, or undefined once it did. */
export function applyPatchFile(files: PackageFiles, text: string): string | undefined {
  let patches;
  try {
    patches = parsePatch(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  // Checked in full before anything is written: a patch applies as a whole or not at all.
  const out: [string, string | null][] = [];
  for (const p of patches) {
    const from = strip(p.oldFileName), to = strip(p.newFileName);
    const path = to ?? from;
    if (!path) continue;
    if (p.isDelete || to === undefined) {
      out.push([path, null]);
      continue;
    }
    const source = p.isCreate || from === undefined ? "" : files.readText(from);
    if (source === undefined) return `${from} isn't in the package`;
    const result = p.hunks.length ? applyPatch(source, p) : source;
    if (result === false) return `${path} doesn't match the patch`;
    if (p.isRename && from && from !== to) out.push([from, null]);
    out.push([path, result]);
  }
  for (const [path, data] of out) data === null ? files.remove(path) : files.write(path, data);
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** git's object id of a blob with this content. */
async function blobId(data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

const NULL_ID = "0".repeat(40);
const decoder = new TextDecoder();

/**
 * The patch `bun patch --commit` writes: a `git diff --full-index` from the package's own files (`before`) to the edited
 * ones (`after`), by path, in path order. Undefined when nothing changed.
 */
export async function makePatch(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): Promise<string | undefined> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const parts: string[] = [];
  for (const path of paths) {
    const a = before.get(path), b = after.get(path);
    if (a && b && a.length === b.length && a.every((x, i) => x === b[i])) continue;
    // --ignore-cr-at-eol: a file whose lines differ only in a carriage return, or in its last newline, is left out.
    const eol = (t: Uint8Array) => decoder.decode(t).replace(/\r\n/g, "\n").replace(/\n$/, "");
    if (a && b && eol(a) === eol(b)) continue;
    const [ida, idb] = [a ? await blobId(a) : NULL_ID, b ? await blobId(b) : NULL_ID];
    const head = [`diff --git a/${path} b/${path}`];
    // --irreversible-delete: a deleted file's lines aren't written.
    if (!b) {
      parts.push([...head, "deleted file mode 100644", `index ${ida}..${idb}`].join("\n"));
      continue;
    }
    if (!a) head.push("new file mode 100644", `index ${ida}..${idb}`);
    else head.push(`index ${ida}..${idb} 100644`);
    const old = a ? decoder.decode(a) : "";
    const p = structuredPatch(a ? `a/${path}` : "/dev/null", `b/${path}`, old, decoder.decode(b), undefined, undefined, { context: 3 });
    head.push(`--- ${p.oldFileName}`, `+++ ${p.newFileName}`);
    // git's default hunk context: the nearest line above the hunk that starts like a definition (xemit.c get_func_line).
    const lines = old.split("\n");
    let func = "", searched = -1;
    for (const h of p.hunks) {
      const start = h.oldStart - 1;
      for (let i = start - 1; i > searched; i--) {
        if (/^[A-Za-z_$]/.test(lines[i])) {
          func = lines[i].slice(0, 80).trimEnd();
          break;
        }
      }
      searched = start - 1;
      // An empty side is written as the line before it (`-0,0` for a new file).
      const range = (start: number, n: number) => (n === 1 ? `${start}` : `${n ? start : start - 1},${n}`);
      head.push(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${func ? ` ${func}` : ""}`, ...h.lines);
    }
    parts.push(head.join("\n"));
  }
  return parts.length ? parts.join("\n") + "\n" : undefined;
}

/** Where `bun patch --commit` puts a package's patch: `patches/<name>@<version>.patch` (a scope's `/` as `+`). */
export const patchPath = (name: string, version: string) => `patches/${name.replace("/", "+")}@${version}.patch`;
