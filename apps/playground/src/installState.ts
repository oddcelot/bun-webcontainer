import type { VFS } from "@runbun/vfs";
import { parseBunLock, staleInLock } from "./lockfile";
import { vfsWorkspaces } from "./workspaces";

/**
 * Whether the project's dependencies are installed, for the status bar: none declared; some missing from node_modules;
 * bun.lock behind package.json (an install updates it); or all there.
 */
export type InstallState =
  | { kind: "none" }
  | { kind: "missing"; names: string[] }
  | { kind: "stale"; names: string[] }
  | { kind: "installed"; count: number; lock: boolean }
  | { kind: "unreadable"; file: string };

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] | { packages?: string[] } };

export function installState(vfs: VFS): InstallState {
  const text = vfs.readText("package.json");
  if (text === undefined) return { kind: "none" };
  let pkg: Manifest;
  try {
    pkg = JSON.parse(text) as Manifest;
  } catch {
    return { kind: "unreadable", file: "package.json" };
  }
  const workspaces = vfsWorkspaces(vfs, pkg);
  const names = [...new Set([pkg, ...workspaces.map((w) => w.manifest)].flatMap((m) => Object.keys({ ...m.devDependencies, ...m.dependencies })))];
  if (!names.length) return { kind: "none" };
  const lockText = vfs.readText("bun.lock");
  if (lockText !== undefined) {
    let stale: string[];
    try {
      stale = staleInLock(parseBunLock(lockText), pkg, workspaces);
    } catch {
      return { kind: "unreadable", file: "bun.lock" };
    }
    if (stale.length) return { kind: "stale", names: stale };
  }
  const missing = names.filter((n) => !vfs.files.has(`node_modules/${n}/package.json`));
  if (missing.length) return { kind: "missing", names: missing };
  return { kind: "installed", count: names.length, lock: lockText !== undefined };
}
