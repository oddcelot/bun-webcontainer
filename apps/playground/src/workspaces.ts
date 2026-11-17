/**
 * The workspaces a root package.json declares (`"workspaces": ["packages/*"]` or `{ "packages": [...] }`): which
 * folders, as Bun finds them. Patterns are `*`, `**`, `?` and `{a,b}` globs; a leading `!` removes what an earlier
 * pattern matched. A folder counts when it has a package.json with a `name` (Bun skips the others).
 */
import type { VFS } from "@runbun/vfs";
import type { Manifest } from "./lockfileWrite";
import { LINKS, links } from "./links";

export type Workspace = { path: string; manifest: Manifest & { name: string } };

type Root = { workspaces?: string[] | { packages?: string[] } };

/** The patterns of a root package.json, in either form. */
export function workspacePatterns(root: Root): string[] {
  const w = root.workspaces;
  return (Array.isArray(w) ? w : (w?.packages ?? [])).filter((p): p is string => typeof p === "string");
}

/** The regular expression for one path glob. */
function globRegExp(glob: string): RegExp {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` matches any number of folders, including none.
        if (glob[i + 1] === "/") (i++, (out += "(?:.*/)?"));
        else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") (braces++, (out += "(?:"));
    else if (c === "}" && braces) (braces--, (out += ")"));
    else if (c === "," && braces) out += "|";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const clean = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * The workspaces among `dirs` (every folder of the project with a package.json, `""` for the root left out), sorted by
 * path as bun.lock lists them. `read` gives a folder's package.json.
 */
export function findWorkspaces(root: Root, dirs: string[], read: (dir: string) => Manifest | undefined): Workspace[] {
  const matched = new Set<string>();
  for (const raw of workspacePatterns(root)) {
    const negated = raw.startsWith("!");
    const re = globRegExp(clean(negated ? raw.slice(1) : raw));
    for (const dir of dirs) if (dir && re.test(dir)) negated ? matched.delete(dir) : matched.add(dir);
  }
  const out: Workspace[] = [];
  for (const path of [...matched].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const manifest = read(path);
    if (manifest?.name) out.push({ path, manifest: manifest as Workspace["manifest"] });
  }
  return out;
}

/** Every folder of the project (below the root) with a package.json, outside node_modules. */
export const packageDirs = (vfs: Pick<VFS, "files">): string[] =>
  [...vfs.files.keys()].filter((p) => p.endsWith("/package.json") && !p.split("/").includes("node_modules")).map((p) => p.slice(0, -"/package.json".length));

/**
 * Keeps each installed workspace's (and `link:` folder's) copy in node_modules (the VFS has no symlinks) equal to its
 * folder: a file saved, created or removed in a workspace is saved, created or removed in `node_modules/<name>` too. Only
 * for workspaces that have a copy (an install made it), and never for what is itself under node_modules.
 */
export function mirrorWorkspaces(vfs: VFS) {
  let known: { path: string; manifest: { name: string } }[] | undefined;
  vfs.onChange(({ path, removed }) => {
    if (path === LINKS) known = undefined;
    if (path.split("/").includes("node_modules")) return;
    if (path === "package.json" || /(^|\/)package\.json$/.test(path)) known = undefined;
    if (known === undefined) {
      const text = vfs.readText("package.json");
      try {
        known = text === undefined ? [] : vfsWorkspaces(vfs, JSON.parse(text));
      } catch {
        known = [];
      }
      // `bun link`ed folders too: a `link:` dependency is a symlink in native Bun.
      for (const [name, dir] of Object.entries(links(vfs))) known.push({ path: dir, manifest: { name } });
    }
    for (const { path: dir, manifest } of known) {
      if (!path.startsWith(`${dir}/`) || !vfs.files.has(`node_modules/${manifest.name}/package.json`)) continue;
      const dest = `node_modules/${manifest.name}/${path.slice(dir.length + 1)}`;
      if (removed) vfs.remove(dest);
      else {
        const data = vfs.read(path);
        if (data !== undefined) vfs.write(dest, data);
      }
    }
  });
}

/** The workspaces of the project in `vfs`. Scans every file path, so only when the root declares any. */
export function vfsWorkspaces(vfs: Pick<VFS, "files" | "readText">, root: Root): Workspace[] {
  if (!workspacePatterns(root).length) return [];
  return findWorkspaces(root, packageDirs(vfs), (dir) => {
    try {
      const text = vfs.readText(`${dir}/package.json`);
      return text === undefined ? undefined : (JSON.parse(text) as Manifest);
    } catch {
      return undefined;
    }
  });
}
