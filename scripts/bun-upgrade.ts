#!/usr/bin/env bun
// Keeps bun/ on Bun releases: the patch series in patches/bun/ follows release tags, not main.
//
//   scripts/bun-upgrade.ts --check [tag]   Is there a newer release (default: the latest), and do our patches apply
//                                          to it? Changes nothing. Exit: 0 up to date, 2 newer release and the
//                                          patches apply, 3 newer release but patches conflict, 1 error.
//   scripts/bun-upgrade.ts [tag]           Rebase bun/'s wasm-experiment branch onto the release, then --finish.
//   scripts/bun-upgrade.ts --finish        After resolving a rebase that stopped on a conflict (and
//                                          `git -C bun rebase --continue`): update the pins, vendored crates,
//                                          toolchains, the playground's version and @types/bun, export the
//                                          patches, run the wasm tests.
//   --no-test                              With an upgrade or --finish: skip the wasm builds and tests.
import { $ } from "bun";
import { existsSync, globSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as pins from "./bun-pins.ts";

const { BUN_BRANCH, BUN_COMMIT, BUN_TAG, BUN_VERSION, LOLHTML_COMMIT, ARGON2_COMMIT, TOOLCHAIN } = pins;
const UPSTREAM = "https://github.com/oven-sh/bun.git";
const root = resolve(import.meta.dir, "..");
const bun = join(root, "bun");
const targetFile = join(bun, ".git/bun-upgrade-target");
const patchFiles = () => globSync("patches/bun/*.patch", { cwd: root }).sort().map((p) => join(root, p));

const say = (s = "") => console.log(s);
function die(msg: string): never {
  console.error(`bun-upgrade: ${msg}`);
  process.exit(1);
}

const out = async (p: $.ShellPromise) => (await p.quiet().nothrow().text()).trim();

async function latestTag(): Promise<string> {
  const refs = await out($`git ls-remote --tags --refs ${UPSTREAM} ${"bun-v*"}`);
  const tags = refs
    .split("\n")
    .map((l) => l.replace(/.*refs\/tags\//, ""))
    .filter((t) => /^bun-v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => Bun.semver.order(a.slice(5), b.slice(5)));
  return tags.at(-1) ?? "";
}
// Whether version a is newer than b.
const newer = (a: string, b: string) => Bun.semver.order(a, b) === 1;
// A pinned commit in one of Bun's dependency scripts.
async function depCommit(file: string, name: string): Promise<string> {
  return (await readFile(file, "utf8")).match(new RegExp(`${name} = "([0-9a-f]{40})"`))?.[1] ?? "";
}
async function channel(file: string): Promise<string> {
  return (await readFile(file, "utf8")).match(/^channel = "(.*)"/m)?.[1] ?? "";
}
// What a release changes besides the code: toolchain and vendored crates (<checkout dir>).
async function pinChanges(dir: string) {
  const t = await channel(join(dir, "rust-toolchain.toml"));
  const l = await depCommit(join(dir, "scripts/build/deps/lolhtml.ts"), "LOLHTML_COMMIT");
  const a = await depCommit(join(dir, "scripts/build/deps/rust-argon2.ts"), "RUST_ARGON2_COMMIT");
  if (t !== TOOLCHAIN) say(`  toolchain: ${TOOLCHAIN} -> ${t}`);
  if (l !== LOLHTML_COMMIT) say(`  lol-html: ${LOLHTML_COMMIT} -> ${l}`);
  if (a !== ARGON2_COMMIT) say(`  rust-argon2: ${ARGON2_COMMIT} -> ${a}`);
}
let identity: string[] | undefined;
async function gitId(args: string[]) {
  identity ??= [
    "-c", `user.name=${(await out($`git config user.name`)) || "bun-upgrade"}`,
    "-c", `user.email=${(await out($`git config user.email`)) || "bun-upgrade@localhost"}`,
  ];
  return $`git ${identity} ${args}`.quiet().nothrow();
}

async function check(explicit: string): Promise<number> {
  const tag = explicit || (await latestTag());
  if (!tag) die(`no release tags found at ${UPSTREAM}`);
  const ver = tag.slice("bun-v".length);
  const pinned = BUN_TAG || BUN_COMMIT;
  if (!explicit && !newer(ver, BUN_VERSION)) {
    say(`bun-upgrade: up to date (pinned ${pinned} is Bun ${BUN_VERSION}; latest release is ${tag})`);
    return 0;
  }
  if (newer(ver, BUN_VERSION)) say(`bun-upgrade: ${tag} is out (pinned: ${pinned}, Bun ${BUN_VERSION}).`);
  say(`bun-upgrade: trying patches/bun on ${tag}…`);

  const tmp = await mkdtemp(join(tmpdir(), "bun-upgrade-"));
  try {
    await $`git init -q ${tmp}`;
    // Borrow bun/'s objects when there is a checkout, so only what's new is downloaded.
    if (existsSync(join(bun, ".git/objects"))) await writeFile(join(tmp, ".git/objects/info/alternates"), `${join(bun, ".git/objects")}\n`);
    // The pinned commit too: `am -3` needs the blobs the patches were made against.
    await $`git -C ${tmp} fetch -q --depth 1 ${UPSTREAM} ${`refs/tags/${tag}:refs/tags/${tag}`} ${BUN_COMMIT}`;
    await $`git -C ${tmp} -c advice.detachedHead=false checkout -q ${`${tag}^{commit}`}`;

    let ok = 0;
    let bad = 0;
    for (const p of patchFiles()) {
      if ((await gitId(["-C", tmp, "am", "-q", "-3", p])).exitCode === 0) {
        ok++;
      } else {
        bad++;
        const files = (await out($`git -C ${tmp} diff --name-only --diff-filter=U`)).split("\n").filter(Boolean).map((f) => `${f} `).join("");
        say(`  ✗ ${basename(p)}: ${files || "does not apply"}`);
        // Back to before this patch, whatever state the failed am left (git versions differ after a
        // modify/delete conflict), so the next patch is tried on its own.
        await gitId(["-C", tmp, "am", "--abort"]);
        await $`git -C ${tmp} reset -q --hard`.quiet().nothrow();
        await rm(join(tmp, ".git/rebase-apply"), { recursive: true, force: true });
      }
    }
    await pinChanges(tmp);
    if (bad === 0) {
      say(`bun-upgrade: all ${ok} patches apply to ${tag}. Upgrade with: scripts/bun-upgrade.ts ${tag}`);
      return 2;
    }
    say(`bun-upgrade: ${bad} of ${ok + bad} patches conflict with ${tag} (later ones may only depend on an earlier conflict).`);
    say(`  Upgrade with: scripts/bun-upgrade.ts ${tag}, then resolve the rebase in bun/ and run --finish.`);
    return 3;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function upgrade(explicit: string): Promise<number> {
  if (!existsSync(join(bun, ".git"))) die("no bun/ checkout; run scripts/setup-bun.ts first");
  if (await out($`git -C ${bun} status --porcelain --untracked-files=no`)) die("bun/ has uncommitted changes");
  if ((await out($`git -C ${bun} branch --show-current`)) !== BUN_BRANCH) die(`bun/ is not on ${BUN_BRANCH}`);
  // Patches must match the branch, or the rebase would carry work patches/bun/ doesn't have.
  const commits = await out($`git -C ${bun} rev-list --count ${`${BUN_COMMIT}..${BUN_BRANCH}`}`);
  if (commits !== String(patchFiles().length)) {
    die(`bun/ has ${commits} commits but patches/bun/ doesn't match; run scripts/export-bun-patches.ts`);
  }

  const tag = explicit || (await latestTag());
  if (!explicit && !newer(tag.slice("bun-v".length), BUN_VERSION)) {
    say(`bun-upgrade: already on Bun ${BUN_VERSION} (${tag} is the latest release)`);
    return 0;
  }
  say(`bun-upgrade: rebasing ${BUN_BRANCH} from ${BUN_TAG || BUN_COMMIT} onto ${tag}…`);
  await $`git -C ${bun} fetch -q --depth 1 origin ${`refs/tags/${tag}:refs/tags/${tag}`}`;
  await writeFile(targetFile, `${tag}\n`);
  if ((await gitId(["-C", bun, "rebase", "-q", "--onto", `${tag}^{commit}`, BUN_COMMIT, BUN_BRANCH])).exitCode !== 0) {
    say();
    say("bun-upgrade: the rebase stopped on a conflict. In bun/: fix the files, `git add` them,");
    say("  `git rebase --continue` (repeat), then run: scripts/bun-upgrade.ts --finish");
    say(`  To give up: git -C bun rebase --abort && rm ${targetFile}`);
    return 3;
  }
  return finish();
}

// Replaces the first match of re in file with text.
async function edit(file: string, re: RegExp, text: string) {
  await writeFile(file, (await readFile(file, "utf8")).replace(re, () => text));
}
const setPin = (name: string, value: string) =>
  edit(join(root, "scripts/bun-pins.ts"), new RegExp(`^export const ${name} = "[^"]*"`, "m"), `export const ${name} = "${value}"`);

async function finish(): Promise<number> {
  if (!existsSync(targetFile)) die("no upgrade in progress");
  if (existsSync(join(bun, ".git/rebase-merge")) || existsSync(join(bun, ".git/rebase-apply"))) die("the rebase in bun/ isn't finished");
  const tag = (await readFile(targetFile, "utf8")).trim();
  const next = await out($`git -C ${bun} rev-parse ${`${tag}^{commit}`}`);
  if ((await $`git -C ${bun} merge-base --is-ancestor ${next} ${BUN_BRANCH}`.quiet().nothrow()).exitCode !== 0) die(`${BUN_BRANCH} isn't based on ${tag}`);
  const ver = tag.slice("bun-v".length);
  const toolchain = await channel(join(bun, "rust-toolchain.toml"));

  await setPin("BUN_COMMIT", next);
  await setPin("BUN_TAG", tag);
  await setPin("BUN_VERSION", ver);
  await setPin("LOLHTML_COMMIT", await depCommit(join(bun, "scripts/build/deps/lolhtml.ts"), "LOLHTML_COMMIT"));
  await setPin("ARGON2_COMMIT", await depCommit(join(bun, "scripts/build/deps/rust-argon2.ts"), "RUST_ARGON2_COMMIT"));
  await setPin("TOOLCHAIN", toolchain);
  // The wrapper crates' workspace (root rust-toolchain.toml) builds with the same nightly as bun/.
  await edit(join(root, "rust-toolchain.toml"), /^channel = ".*"/m, `channel = "${toolchain}"`);
  // The tests compare against native Bun of the same release (proto pins it for moon and the shell).
  await edit(join(root, ".prototools"), /^bun = ".*"/m, `bun = "${ver}"`);
  await edit(join(root, "apps/playground/src/worker/bunVersion.ts"), /BUN_VERSION = ".*"/, `BUN_VERSION = "${ver}"`);
  // The editor's type checker bundles Bun's type definitions (apps/playground/src/typecheck/bunTypes.ts).
  // It globs them from apps/playground/node_modules, so bun-types (and @types/node, undici-types) are declared there too.
  const added = await $`bun add -d --exact ${`@types/bun@${ver}`} ${`bun-types@${ver}`}`.cwd(join(root, "apps/playground")).quiet().nothrow();
  if (added.exitCode !== 0) {
    say(`bun-upgrade: @types/bun@${ver} isn't published yet; run \`bun add -d --exact @types/bun@${ver} bun-types@${ver}\` in apps/playground/ once it is`);
  } else {
    // The root's @types/bun types the scripts (moon run root:typecheck-scripts).
    await $`bun add -d --exact ${`@types/bun@${ver}`}`.cwd(root).quiet().nothrow();
  }

  await $`${join(root, "scripts/bun-prepare.ts")} ${bun}`;
  await $`${join(root, "scripts/export-bun-patches.ts")}`.quiet();
  await rm(targetFile, { force: true });
  say(`bun-upgrade: bun/ is on ${tag}; pins, toolchains, version and patches/bun/ updated.`);

  let testsFailed = false;
  if (noTest) say("bun-upgrade: tests skipped (--no-test)");
  else testsFailed = !(await runTests(toolchain));
  const native = (await out($`bun --version`)) || "none";
  if (native !== ver) say(`bun-upgrade: native bun is ${native}; \`bun upgrade\` to ${ver} so the tests compare like with like`);
  say(`bun-upgrade: review \`git status\`, then commit (e.g. "bun: upgrade to ${tag}").`);
  return testsFailed ? 1 : 0;
}

// Whether every crate's build and test passed.
async function runTests(toolchain: string): Promise<boolean> {
  const failed: string[] = [];
  for (const d of ["semver-wasm", "transpile-wasm", "sys-wasm", "resolve-wasm", "bundle-wasm", "fmt-wasm"]) {
    say(`bun-upgrade: ${d}…`);
    const cwd = join(root, "crates", d);
    const log = `/tmp/bun-upgrade-${d}.log`;
    const built = await $`cargo ${`+${toolchain}`} build -Zbuild-std=std,panic_abort --target wasm64-unknown-unknown --release -q`.cwd(cwd).quiet().nothrow();
    const tested = built.exitCode === 0 ? await $`node test.ts`.cwd(cwd).quiet().nothrow() : undefined;
    if (tested) await Bun.write(log, tested.stdout.toString() + tested.stderr.toString());
    if (tested?.exitCode === 0) {
      say("  ok");
    } else {
      failed.push(d);
      say(`  FAILED (see ${log})`);
    }
  }
  say(failed.length === 0 ? "bun-upgrade: all wasm tests pass" : `bun-upgrade: failing: ${failed.join(" ")}`);
  return failed.length === 0;
}

let noTest = false;
let mode: "check" | "finish" | "upgrade" = "upgrade";
let arg = "";
for (const a of process.argv.slice(2)) {
  if (a === "--check") mode = "check";
  else if (a === "--finish") mode = "finish";
  else if (a === "--no-test") noTest = true;
  else if (a.startsWith("-")) die(`unknown option ${a}`);
  else arg = a;
}
process.exit(mode === "check" ? await check(arg) : mode === "finish" ? await finish() : await upgrade(arg));
