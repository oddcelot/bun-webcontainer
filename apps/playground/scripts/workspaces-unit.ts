// Which folders a root package.json's `workspaces` name (src/workspaces.ts), what makes bun.lock's workspaces stale
// (src/lockfile.ts staleInLock), and the VFS copy of a workspace in node_modules following its folder's edits.
import { staleInLock } from "../src/lockfile";
import { catalogRange, catalogsOf } from "../src/catalogs";
import { intersects, overridesOf } from "../src/overrides";
import { authFor, parseNpmrc, registryFor } from "../src/npmrc";
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

const cats = catalogsOf({ workspaces: { packages: ["a"], catalog: { x: "1", y: 2 }, catalogs: { n: { z: "3" }, default: { d: "4" } } }, catalog: { ignored: "9" } });
eq("catalogs from the workspaces object", cats, { default: { x: "1" }, groups: { n: { z: "3" }, default: { d: "4" } } });
eq("catalogs at the top", catalogsOf({ workspaces: ["a"], catalog: { x: "1" } }).default, { x: "1" });
eq("no catalogs without workspaces", catalogsOf({ catalog: { x: "1" } }).default, {});
eq("catalog: finds the default", [catalogRange(cats, "", "x"), catalogRange(cats, "", "d"), catalogRange(cats, "default", "x"), catalogRange(cats, "default", "d")], ["1", "4", "1", "4"]);
eq("a named one", [catalogRange(cats, "n", "z"), catalogRange(cats, "n", "x"), catalogRange(cats, "none", "x")], ["3", undefined, undefined]);
eq("catalog entry changed", staleInLock({ ...lock, catalog: { x: "1" } }, { dependencies: { a: "1" }, workspaces: ["a"], catalog: { x: "2" } }), ["catalog x"]);
eq("catalog entry added", staleInLock(lock, { dependencies: { a: "1" }, workspaces: ["a"], catalogs: { n: { z: "1" } } }), ["catalog n/z"]);

const semver = { order: (x: string, y: string) => Bun.semver.order(x, y), satisfies: (v: string, r: string) => Bun.semver.satisfies(v, r) };
const ov = overridesOf({
  dependencies: { ms: "^2" },
  resolutions: { ignored: "1" },
  overrides: { "//": "note", a: "1", "**/b": "^2", "@s/c": "$ms", d: "$missing", e: "", f: "-", g: "patch:x", "h@1": "2", "i>j": "3", "k/l": "4", m: { n: "5", ".": "6" }, "o@^1": { p: "7", "q@2": "8" } },
});
eq("flat overrides", ov.rules, { a: "1", b: "^2", "@s/c": "^2", m: "6" });
eq("scoped ones", ov.scoped.map((r) => [r.parent && `${r.parent.name}@${r.parent.range}`, `${r.target.name}@${r.target.range}`, r.value]), [
  [undefined, "h@1", "2"],
  ["i@", "j@", "3"],
  ["k@", "l@", "4"],
  ["m@", "n@", "5"],
  ["o@^1", "p@", "7"],
  ["o@^1", "q@2", "8"],
]);
eq("resolutions only without overrides", overridesOf({ resolutions: { "**/x": "1" } }).rules, { x: "1" });
eq("resolutions take strings", overridesOf({ resolutions: { x: { y: "1" } } }).scoped, []);
eq("yarn and pnpm paths", overridesOf({ resolutions: { "a/b": "1", "**/c/d": "2", "e/**/f": "3", "@s/g/h": "4", "i>@s/j": "5", "k/l/m": "6", "n@npm:@s/o@^1/p": "7" } }).scoped.map((r) => `${r.parent?.name}>${r.target.name}`), ["a>b", "c>d", "e>f", "@s/g>h", "i>@s/j"]);
eq("a workspace's range for $name", overridesOf({ overrides: { x: "$x", y: "$y" } }, [{ dependencies: { x: "^1" } }, { devDependencies: { x: "^1", y: "1" } }, { dependencies: { y: "2" } }]).rules, { x: "^1" });
eq("overrides that aren't a map", overridesOf({ overrides: [] }).errors.length, 1);
eq("ranges that overlap (as npm`s intersects says)", [["1", "^1.2.0"], ["1.2.3", "~1.2.0"], ["^1 || ^3", "3.x"], ["2 - 3", "<=2.0.0"], ["^0.0.3", "0.0.3"], ["1.x", "^2"], [">2", "<=2"], ["<1", ">=1"], ["^0.1.0", ">0.1.1 <0.1.5"], ["*", "^4"]].map(([a, b]) => intersects(a, b, semver)), [true, true, true, true, true, false, false, false, true, true]);
const dep = (name: string, range: string) => ({ name, range });
const scoped = overridesOf({ overrides: { a: "1", x: { a: "2", "b@^1": "3" }, "x@^2": { a: "4" }, "c@^1": "5", "x@3": { "a@^9": "6" } } });
eq("flat rule", scoped.lookup(dep("a", "^9"), { name: "z" }, semver), "1");
eq("parent", scoped.lookup(dep("a", "^9"), { name: "x" }, semver), "2");
eq("ranged parent wins", scoped.lookup(dep("a", "^9"), { name: "x", version: "2.1.0" }, semver), "4");
eq("parent range not met", scoped.lookup(dep("a", "^9"), { name: "x", version: "1.0.0" }, semver), "2");
eq("target range", [scoped.lookup(dep("b", "^1.2.0"), { name: "x" }, semver), scoped.lookup(dep("b", "^2.0.0"), { name: "x" }, semver), scoped.lookup(dep("b", "latest"), { name: "x" }, semver)], ["3", undefined, undefined]);
eq("name@range key", [scoped.lookup(dep("c", ">=1.5.0"), { name: "z" }, semver), scoped.lookup(dep("c", "^2"), { name: "z" }, semver)], ["5", undefined]);
eq("an alias isn't selected by a plain key", scoped.lookup(dep("a", "npm:other@^1"), { name: "z" }, semver), undefined);
eq("override changed", staleInLock({ ...lock, overrides: { a: "1" } }, { dependencies: { a: "1" }, overrides: { a: "2" } }), ["override a"]);
eq("override added", staleInLock(lock, { dependencies: { a: "1" }, resolutions: { b: "1" } }), ["override b"]);
eq("scoped override unchanged", staleInLock({ ...lock, overrides: { a: { ".": "1", "b@^1": "2" }, "c@1": { ".": "3" }, "d": { e: "4" } } }, { dependencies: { a: "1" }, overrides: { a: { ".": "1", "b@^1": "2" }, "c@1": "3", "d>e": "4" } }), []);
eq("scoped override changed", staleInLock({ ...lock, overrides: { d: { e: "4" } } }, { dependencies: { a: "1" }, overrides: { "d>e": "5" } }), ["override d > e"]);

const rc = parseNpmrc(`; comment
# another
registry = "https://reg.example.com/npm/"
@acme:registry=https://acme.example.com/
@bad:registry=ftp://nope
//acme.example.com/:_authToken=tok
//reg.example.com/npm/:_auth=dXNlcjpwdw==
//reg.example.com/:_authToken=${"$"}{TOKEN}
`);
eq("default registry", registryFor(rc, "left-pad"), "https://reg.example.com/npm");
eq("scoped registry", [registryFor(rc, "@acme/ui"), registryFor(rc, "@other/ui")], ["https://acme.example.com", "https://reg.example.com/npm"]);
eq("no .npmrc", registryFor(parseNpmrc(undefined), "@acme/ui"), "https://registry.npmjs.org");
eq("credentials by URL", [authFor(rc, "https://acme.example.com/@acme%2fui"), authFor(rc, "https://reg.example.com/npm/x/-/x-1.tgz"), authFor(rc, "https://reg.example.com/other"), authFor(rc, "https://registry.npmjs.org/x")], ["Bearer tok", "Basic dXNlcjpwdw==", undefined, undefined]);
eq("what it can't read", rc.warnings, ["@bad:registry must be an http(s) URL".replace(/^/, ".npmrc: "), ".npmrc: //reg.example.com/:_authToken uses an environment variable, which the browser doesn't have"]);

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
