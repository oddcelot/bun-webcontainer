import type { Semver } from "./semver";
import { installFromBunLock, untar } from "./lockfile";
import type { VFS } from "./vfs";

type Log = (level: "log" | "error", text: string) => void;
type Packument = {
  "dist-tags"?: Record<string, string>;
  versions: Record<string, { dependencies?: Record<string, string>; dist: { tarball: string } }>;
};

async function gunzip(res: Response): Promise<Uint8Array> {
  const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pickVersion(doc: Packument, range: string, semver: Semver): string {
  const tags = doc["dist-tags"] ?? {};
  if (range in tags) return tags[range];
  if (range === "" || range === "*") return tags.latest;
  if (/^(npm|workspace|file|git|github|https?):/.test(range)) throw new Error(`unsupported range "${range}"`);
  let best: string | undefined;
  for (const v of Object.keys(doc.versions)) {
    if (!semver.satisfies(v, range)) continue;
    if (best === undefined || semver.order(v, best) > 0) best = v;
  }
  if (!best) throw new Error(`no version satisfies "${range}"`);
  return best;
}

export async function bunInstall(vfs: VFS, semver: Semver, log: Log): Promise<number> {
  const lock = vfs.readText("bun.lock");
  if (lock !== undefined) {
    log("log", "bun.lock found: installing locked versions");
    return installFromBunLock(vfs, lock, log);
  }
  const text = vfs.readText("package.json");
  if (!text) throw new Error("no package.json");
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const seen = new Set<string>();
  let installed = 0;

  async function add(name: string, range: string): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);
    if (vfs.files.has(`node_modules/${name}/package.json`)) return;
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (!res.ok) throw new Error(`registry ${res.status}`);
      const doc = (await res.json()) as Packument;
      const version = pickVersion(doc, range, semver);
      const meta = doc.versions[version];
      const tar = await fetch(meta.dist.tarball);
      if (!tar.ok) throw new Error(`tarball ${tar.status}`);
      const dec = new TextDecoder("utf-8", { fatal: true });
      for (const { name: entry, data } of untar(await gunzip(tar))) {
        const rel = entry.split("/").slice(1).join("/");
        if (!rel) continue;
        let content: string | Uint8Array = data;
        try {
          content = dec.decode(data);
        } catch {}
        vfs.write(`node_modules/${name}/${rel}`, content);
      }
      installed++;
      log("log", `+ ${name}@${version}`);
      await Promise.all(Object.entries(meta.dependencies ?? {}).map(([n, r]) => add(n, r)));
    } catch (e) {
      log("error", `install ${name}@${range}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await Promise.all(Object.entries({ ...pkg.devDependencies, ...pkg.dependencies }).map(([n, r]) => add(n, r)));
  return installed;
}
