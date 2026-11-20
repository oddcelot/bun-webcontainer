#!/usr/bin/env bun
// The playground for self-hosting (hosting/README.md): packs a build for any host (dist-release/, built by the moon task
// `playground:release-archive` without a hosting file) with the script that points it at one, into
// dist-release/runbun-playground-<version>.tar.gz, the root package.json's version. Attach it to the GitHub Release:
//   gh release upload v<version> apps/playground/dist-release/runbun-playground-<version>.tar.gz
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const app = join(import.meta.dir, "..");
const out = join(app, "dist-release");
const build = join(out, "dist");
const { version } = await Bun.file(join(app, "../../package.json")).json();
const name = `runbun-playground-${version}`;
const dir = join(out, name);

if (!existsSync(join(build, "hosting.js"))) {
  console.error(`release-archive: no ${build}/hosting.js: run \`moon run playground:release-archive\`, which builds it`);
  process.exit(1);
}
const hosting = await Bun.file(join(build, "hosting.js")).text();
if (!hosting.includes('"contentOrigin":null') || hosting.includes("canary\":true")) {
  console.error("release-archive: the build has a hosting file's host in it; build it without HOSTING");
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(build, join(dir, "dist"), { recursive: true });
for (const [from, to] of [
  ["hosting/configure.ts", "configure.ts"],
  ["hosting/load.ts", "load.ts"],
  ["hosting/RELEASE.md", "README.md"],
  ["hosting/example.json", "hosting.example.json"],
])
  cpSync(join(app, from), join(dir, to));
await Bun.write(join(dir, "VERSION"), `${version}\n`);

const archive = join(out, `${name}.tar.gz`);
rmSync(archive, { force: true });
const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", out, name], { stdout: "inherit", stderr: "inherit" });
if (tar.exitCode) process.exit(tar.exitCode);
rmSync(dir, { recursive: true, force: true });
console.log(`release-archive: ${archive} (${(Bun.file(archive).size / 1e6).toFixed(1)} MB)`);
