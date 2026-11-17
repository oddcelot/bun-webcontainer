/**
 * `bun link`'s registry. Native Bun links a package folder into ~/.bun/install/global/node_modules, where a `link:<name>`
 * dependency of any project finds it. Here a project is all there is: `bun link` in one of its folders registers that
 * folder by its package's name, in this file of the project, and `link:<name>` installs a copy of it (the VFS has no
 * symlinks; edits to it are copied along, workspaces.ts mirrorWorkspaces).
 */
import type { VFS } from "@runbun/vfs";

export const LINKS = "node_modules/.bun-links.json";

/** The registered folders by package name. */
export function links(vfs: Pick<VFS, "readText">): Record<string, string> {
  try {
    const parsed = JSON.parse(vfs.readText(LINKS) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Registers (`dir`) or forgets (undefined) the folder of package `name`. */
export function setLink(vfs: Pick<VFS, "readText" | "write" | "remove">, name: string, dir: string | undefined) {
  const all = links(vfs);
  if (dir === undefined) delete all[name];
  else all[name] = dir;
  if (Object.keys(all).length) vfs.write(LINKS, JSON.stringify(all, null, 2) + "\n");
  else vfs.remove(LINKS);
}
