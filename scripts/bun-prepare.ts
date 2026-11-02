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

// cargo resolves the whole workspace, so these path dependencies must exist even though
// nothing we build uses them. Bun's own build also applies patches to them; we don't need those.
async function vendor(name: string, repo: string, commit: string) {
  const target = join(dir, "vendor", name);
  const pinned = Bun.file(join(target, ".pinned"));
  if ((await pinned.exists()) && (await pinned.text()).trim() === commit) return;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await $`curl -fsSL ${`https://github.com/${repo}/archive/${commit}.tar.gz`} | tar xz --strip-components=1 -C ${target}`;
  await Bun.write(pinned, `${commit}\n`);
}
await vendor("lolhtml", "oven-sh/lol-html", LOLHTML_COMMIT);
await vendor("rust-argon2", "sru-systems/rust-argon2", ARGON2_COMMIT);

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
