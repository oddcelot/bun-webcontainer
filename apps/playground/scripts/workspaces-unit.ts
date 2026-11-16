// Which folders a root package.json's `workspaces` name (src/workspaces.ts), what makes bun.lock's workspaces stale
// (src/lockfile.ts staleInLock), and the VFS copy of a workspace in node_modules following its folder's edits.
import { staleInLock } from "../src/lockfile";
import { findWorkspaces, mirrorWorkspaces, packageDirs, vfsWorkspaces } from "../src/workspaces";
import { VFS } from "@runbun/vfs";

let bad = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

const dirs = ["packages/a", "packages/b", "packages/b/inner", "packages/c/deep", "apps/web", "apps/skip", "tools", "other/x"];
const read = (dir: string) => (dir === "apps/noname" ? {} : { name: dir.replace(/\//g, "-") });
const paths = (patterns: string[] | { packages: string[] }) => findWorkspaces({ workspaces: patterns }, dirs, read).map((w) => w.path);
eq("one star", paths(["packages/*"]), ["packages/a", "packages/b"]);
eq("object form", paths({ packages: ["apps/*", "tools"] }), ["apps/skip", "apps/web", "tools"]);
eq("two stars", paths(["packages/**"]), ["packages/a", "packages/b", "packages/b/inner", "packages/c/deep"]);
eq("negation", paths(["apps/*", "!apps/skip"]), ["apps/web"]);
eq("braces and ./", paths(["./{apps,other}/*"]), ["apps/skip", "apps/web", "other/x"]);
eq("trailing slash", paths(["tools/"]), ["tools"]);
eq("unnamed ones are skipped", findWorkspaces({ workspaces: ["apps/*"] }, ["apps/noname"], read), []);
eq("none", paths([]), []);

const lock = { lockfileVersion: 2, workspaces: { "": { dependencies: { a: "1" } }, "packages/x": { name: "x", dependencies: { b: "^1" } } }, packages: {} };
const x = { path: "packages/x", manifest: { name: "x", dependencies: { b: "^1" } } };
eq("workspaces unchanged", staleInLock(lock, { dependencies: { a: "1" } }, [x]), []);
eq("not asked about workspaces", staleInLock(lock, { dependencies: { a: "1" } }), []);
eq("workspace dependency changed", staleInLock(lock, { dependencies: { a: "1" } }, [{ ...x, manifest: { name: "x", dependencies: { b: "^2" } } }]), ["packages/x"]);
eq("workspace added", staleInLock(lock, { dependencies: { a: "1" } }, [x, { path: "packages/y", manifest: { name: "y" } }]), ["packages/y"]);
eq("workspace removed", staleInLock(lock, { dependencies: { a: "1" } }, []), ["packages/x"]);

const vfs = new VFS();
vfs.write("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
vfs.write("packages/lib/package.json", JSON.stringify({ name: "@m/lib" }));
vfs.write("packages/lib/index.js", "1");
vfs.write("packages/lib/node_modules/dep/package.json", "{}");
eq("packageDirs", packageDirs(vfs), ["packages/lib"]);
eq("vfsWorkspaces", vfsWorkspaces(vfs, JSON.parse(vfs.readText("package.json")!)).map((w) => w.manifest.name), ["@m/lib"]);
mirrorWorkspaces(vfs);
// Not installed: nothing to keep up.
vfs.write("packages/lib/index.js", "2");
eq("not installed", vfs.files.has("node_modules/@m/lib/index.js"), false);
// Installed: the copy follows.
vfs.write("node_modules/@m/lib/package.json", "{}");
vfs.write("node_modules/@m/lib/index.js", "2");
vfs.write("packages/lib/index.js", "3");
vfs.write("packages/lib/new.js", "n");
eq("edit copied", vfs.readText("node_modules/@m/lib/index.js"), "3");
eq("new file copied", vfs.readText("node_modules/@m/lib/new.js"), "n");
vfs.remove("packages/lib/new.js");
eq("removal copied", vfs.files.has("node_modules/@m/lib/new.js"), false);
eq("the workspace's own node_modules aren't copied", vfs.files.has("node_modules/@m/lib/node_modules/dep/package.json"), false);

if (bad) process.exit(1);
console.log("✓ workspaces");
