#!/usr/bin/env bun
// Adds what the wasm builds need to a bun/ checkout that git doesn't track: the vendored crates cargo resolves,
// the generated inputs `bun bd --configure-only` would write, and the pinned toolchain. Run by setup-bun.ts and
// bun-upgrade.ts; safe to run again (vendored crates are refetched when their pinned commit changed).
// Usage: scripts/bun-prepare.ts [dir]   (default: ./bun)
import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ARGON2_COMMIT, LOLHTML_COMMIT, TOOLCHAIN } from "./bun-pins.ts";

const root = resolve(import.meta.dir, "..");
const dir = process.argv[2] ?? join(root, "bun");

// cargo resolves the whole workspace, so these path dependencies must exist even where nothing we build uses them.
// rust-argon2 is built (resolve-wasm, for `Bun.password`), with the patches Bun's own build applies to it.
async function vendor(name: string, repo: string, commit: string, patches: string[] = []) {
  const target = join(dir, "vendor", name);
  const pinned = Bun.file(join(target, ".pinned"));
  const stamp = [commit, ...patches].join("\n");
  if ((await pinned.exists()) && (await pinned.text()).trim() === stamp) return;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await $`curl -fsSL ${`https://github.com/${repo}/archive/${commit}.tar.gz`} | tar xz --strip-components=1 -C ${target}`;
  for (const patch of patches) await $`patch -p1 --quiet -d ${target} -i ${join(dir, patch)}`;
  await Bun.write(pinned, `${stamp}\n`);
}
const { rustArgon2 } = await import(join(dir, "scripts/build/deps/rust-argon2.ts"));
await vendor("lolhtml", "oven-sh/lol-html", LOLHTML_COMMIT);
await vendor("rust-argon2", "sru-systems/rust-argon2", ARGON2_COMMIT, rustArgon2.patches);

// Generated inputs that `bun bd --configure-only` would write.
const codegenDir = join(dir, "build/debug/codegen");
await mkdir(codegenDir, { recursive: true });
await cp(join(root, "patches/bun-codegen/build_options.rs"), join(codegenDir, "build_options.rs"));
const { generateJsonByteClass } = await import(join(dir, "scripts/build/jsonByteClass.ts"));
const { generateXmlByteClass } = await import(join(dir, "scripts/build/xmlByteClass.ts"));
const cfg = { codegenDir };
generateJsonByteClass(cfg);
generateXmlByteClass(cfg);

// Minimal install; letting rust-toolchain.toml auto-install pulls ~11 cross targets, miri and clippy.
const toolchains = await $`rustup toolchain list`.text();
if (!toolchains.split("\n").some((l) => l.startsWith(TOOLCHAIN))) {
  await $`rustup toolchain install ${TOOLCHAIN} --profile minimal -c rust-src`;
}
