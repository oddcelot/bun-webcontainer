/**
 * The third-party notices the build ships at /third-party-licenses.txt (vite.config.ts's thirdPartyLicenses): every npm
 * package the bundles took a module from, and every crate linked into the wasm files copy-wasm.ts copies in, with the
 * license texts they come with. Run it on its own (`bun scripts/licenses.ts`) to print the Rust part.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Notice {
  /** `name version`, or what stands in for it ("Bun 1.4.4"). */
  name: string;
  license: string;
  url?: string;
  /** The license and notice files' contents, as shipped. */
  texts: string[];
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

/** The license and notice files directly in `dir`, and in a `licenses/` folder there (tsrs keeps TypeScript's in one). */
function licenseTexts(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (LICENSE_FILE.test(name) && statSync(path).isFile()) files.push(path);
    if (name === "licenses" && statSync(path).isDirectory())
      for (const inner of readdirSync(path).sort())
        if (statSync(join(path, inner)).isFile()) files.push(join(path, inner));
  }
  return files.map((f) => readFileSync(f, "utf8").trim());
}

/** The wasm files the playground ships (scripts/copy-wasm.ts): the package that builds each, per Cargo workspace. */
const WASM_CRATES: { dir: string; target: string; packages: string[] }[] = [
  {
    dir: ".",
    target: "wasm64-unknown-unknown",
    packages: [
      "bun_semver_wasm",
      "bun_compress_wasm",
      "bun_transpile_wasm",
      "bun_bundle_wasm",
      "bun_resolve_wasm",
      "bun_fmt_wasm",
      "bun_check_wasm",
      "bun_shell_wasm",
      "bun_htmlrewriter_wasm",
      "bun_crypto_wasm",
    ],
  },
  {
    dir: "crates/tsrs-ls-wasm",
    target: "wasm32-wasip1",
    packages: ["tsrs_ls_wasm"],
  },
  { dir: "crates/git-wasm", target: "wasm32-wasip1", packages: ["git-wasm"] },
];

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  repository: string | null;
  source: string | null;
  manifest_path: string;
  targets: { kind: string[] }[];
}
interface CargoMetadata {
  packages: CargoPackage[];
  resolve: {
    nodes: {
      id: string;
      deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
    }[];
  };
}

/**
 * The crates linked into the shipped wasm: the normal dependencies of the wasm crates, for their targets (build
 * scripts, proc macros and dev-dependencies don't end up in the binary). Bun's crates are one notice, Bun's.
 */
export function rustNotices(bunVersion: string): Notice[] {
  const notices = new Map<string, Notice>();
  let bun = false;
  for (const ws of WASM_CRATES) {
    const meta: CargoMetadata = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--offline",
          "--filter-platform",
          ws.target,
        ],
        {
          cwd: join(repo, ws.dir),
          encoding: "utf8",
          maxBuffer: 256 << 20,
        },
      ),
    );
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const deps = new Map(meta.resolve.nodes.map((n) => [n.id, n.deps]));
    const seen = new Set<string>();
    const queue = meta.packages
      .filter((p) => ws.packages.includes(p.name) && !p.source)
      .map((p) => p.id);
    if (queue.length !== ws.packages.length)
      throw new Error(
        `licenses: ${ws.packages.join(", ")} not all in ${ws.dir}'s cargo metadata`,
      );
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId.get(id)!;
      if (p.targets.every((t) => t.kind.includes("proc-macro"))) continue;
      for (const d of deps.get(id) ?? [])
        if (d.dep_kinds.some((k) => k.kind === null)) queue.push(d.pkg);

      const dir = dirname(p.manifest_path);
      if (!p.source && dir.startsWith(join(repo, "bun") + sep)) {
        bun = true;
        // A crate Bun ported from another project carries that project's license (src/clap: zig-clap's).
        const texts = licenseTexts(dir);
        if (texts.length)
          notices.set(p.name, {
            name: `${p.name} (Bun's port, in oven-sh/bun)`,
            license: p.license ?? "see below",
            texts,
          });
        continue;
      }
      // The wrapper crates (crates/*) are this project's own code; crates/git-wasm/patched holds patched upstream crates.
      if (!p.source && !dir.includes(`${sep}patched${sep}`)) continue;
      const texts = licenseTexts(dir);
      // A crate from a git checkout often keeps its license at the repository's root.
      if (p.source?.startsWith("git+") && !existsSync(join(dir, ".cargo-ok")))
        for (let up = dirname(dir); up !== dirname(up); up = dirname(up)) {
          texts.push(...licenseTexts(up));
          if (existsSync(join(up, ".cargo-ok"))) break;
        }
      if (p.license_file && existsSync(join(dir, p.license_file)))
        texts.push(readFileSync(join(dir, p.license_file), "utf8").trim());
      const key = `${p.name} ${p.version}`;
      notices.set(key, {
        name: key,
        license: p.license ?? "see below",
        url: p.repository ?? `https://crates.io/crates/${p.name}`,
        texts: [...new Set(texts)],
      });
    }
  }
  if (bun) notices.set("bun", bunNotice(bunVersion));
  return [...notices.values()];
}

/** Bun's crates, compiled to wasm: Bun's license statement and its credits (bun/LICENSE.md; the rest is about the native binary). */
function bunNotice(version: string): Notice {
  const md = readFileSync(join(repo, "bun/LICENSE.md"), "utf8");
  const credits = md.slice(md.indexOf("## Additional credits")).trim();
  return {
    name: `Bun ${version}`,
    license: "MIT",
    url: "https://github.com/oven-sh/bun",
    texts: [
      `${md.split("\n")[0].trim()} (https://github.com/oven-sh/bun/blob/main/LICENSE.md)`,
      credits,
      ESBUILD,
    ],
  };
}

// Bun's transpiler, CSS lexer and resolver are ports of esbuild (bun/LICENSE.md's credits); its license, as published.
const ESBUILD = `esbuild (https://github.com/evanw/esbuild):

MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The npm package a bundled module came from (the last node_modules/<name> in its path), or undefined for our own. */
export function npmPackageDir(moduleId: string): string | undefined {
  const path = moduleId.replace(/^\0/, "").split("?")[0];
  const at = path.lastIndexOf(`${sep}node_modules${sep}`);
  if (at < 0) return;
  const rest = path.slice(at + 14).split(sep);
  const name = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  const dir = join(path.slice(0, at + 14), ...name);
  return existsSync(join(dir, "package.json")) ? dir : undefined;
}

export function npmNotice(dir: string): Notice | undefined {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  // This project's own packages.
  if (pkg.name?.startsWith("@runbun/")) return;
  const repoUrl =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const license =
    typeof pkg.license === "string"
      ? pkg.license
      : (pkg.license?.type ?? "see below");
  return {
    name: `${pkg.name} ${pkg.version}`,
    license,
    url:
      repoUrl?.replace(/^git\+/, "").replace(/\.git$/, "") ??
      `https://www.npmjs.com/package/${pkg.name}`,
    texts: licenseTexts(dir),
  };
}

/** The text file: packages that ship the same texts (an unchanged Apache-2.0, say) share one copy of them. */
export function render(notices: Notice[]): string {
  const groups = new Map<string, Notice[]>();
  for (const n of [...notices].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = n.texts.join("\n\n");
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const rule = "-".repeat(80);
  const sections = [...groups].map(([texts, ns]) => {
    const heads = ns
      .map((n) => `${n.name} (${n.license})${n.url ? `\n  ${n.url}` : ""}`)
      .join("\n");
    return `${rule}\n${heads}\n\n${texts || "The package ships no license file; its license is named above."}`;
  });
  return `Third-party software in runbun.dev
==================================

The playground runs code from the projects below in your browser: npm packages in
its scripts, and Bun's Rust crates (with their dependencies) compiled to
WebAssembly. Each section names packages and the license texts they ship with.

${sections.join("\n\n")}
`;
}

if (import.meta.main)
  process.stdout.write(render(rustNotices(process.argv[2] ?? "(version)")));
