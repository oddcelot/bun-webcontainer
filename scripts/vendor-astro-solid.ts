#!/usr/bin/env bun
// Re-copies packages/astro-solid/src from withastro/astro#17891 (@astrojs/solid-js v8, Solid 2) and records the
// commit in packages/astro-solid/README.md. `scripts/vendor-astro-solid.ts [sha]`; default: the PR's current head.
// `--check` only reports whether the PR merged, its head, and the npm dist-tags (changes nothing). Needs `gh`.
import { $ } from "bun";

const PR = "withastro/astro/pulls/17891";
const dir = new URL("../packages/astro-solid/", import.meta.url).pathname;
const args = process.argv.slice(2);

const pr = JSON.parse(await $`gh api repos/${PR}`.text());
const head: string = pr.head.sha;

if (args.includes("--check")) {
  const tags: Record<string, string> = JSON.parse(await $`npm view @astrojs/solid-js dist-tags --json`.text());
  const v8 = Object.entries(tags).filter(([tag, v]) => tag === "latest" || v.startsWith("8."));
  const vendored = (await Bun.file(`${dir}README.md`).text()).match(/@ `([0-9a-f]{40})`/)?.[1];
  console.log(`PR: ${pr.state}${pr.merged ? " (merged)" : ""}, mergeable=${pr.mergeable_state}, head ${head}`);
  console.log(`vendored: ${vendored}${vendored === head ? " (up to date)" : " (behind)"}`);
  console.log(`npm: ${v8.map(([tag, v]) => `${tag}=${v}`).join(", ")}${v8.some(([, v]) => v.startsWith("8.")) ? " (v8 is out: switch to npm)" : ""}`);
  process.exit(0);
}

const sha = args[0] ?? head;
const repo: string = pr.head.repo.full_name;
const list = JSON.parse(await $`gh api repos/${repo}/contents/packages/integrations/solid/src?ref=${sha}`.text());
await $`rm -rf ${dir}src && mkdir -p ${dir}src`;
for (const { name, download_url } of list as { name: string; download_url: string }[]) {
  await Bun.write(`${dir}src/${name}`, await (await fetch(download_url)).text());
}
const readme = `${dir}README.md`;
await Bun.write(readme, (await Bun.file(readme).text()).replace(/@ `[0-9a-f]{40}`/, `@ \`${sha}\``));
const upstream = JSON.parse(
  await (await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/packages/integrations/solid/package.json`)).text(),
);
console.log(`vendored ${list.length} files from ${repo}@${sha}`);
console.log("upstream deps (keep package.json in step):", upstream.dependencies, upstream.peerDependencies);
