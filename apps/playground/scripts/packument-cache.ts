// When `bun install` reuses a cached packument (src/pkgCache.ts): for 5 minutes, and past that only for an exact
// version it already lists, which a registry can't change once published. A range or a dist-tag could resolve to a
// newer version, so a stale packument is fetched again for those; a cache entry that doesn't parse is fetched again
// too. In an install (src/lockfileWrite.ts), a later range the reused packument can't satisfy fetches it again
// rather than failing. Run with bun: `bun scripts/packument-cache.ts`. Exits 1 on a mismatch.
let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

// A bucket whose cache is a Map, and a registry that counts its fetches.
const entries = new Map<string, Response>();
const cache = {
  match: async (url: string) => entries.get(url)?.clone(),
  put: async (url: string, res: Response) => void entries.set(url, res),
  keys: async () => [],
};
Object.defineProperty(globalThis, "navigator", {
  value: { storageBuckets: { open: async () => ({ caches: { open: async () => cache } }) }, storage: {} },
  configurable: true,
});
let fetches = 0;
const registry = { name: "pkg", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "2.0.0": {} } };
globalThis.fetch = (async () => (fetches++, new Response(JSON.stringify(registry)))) as unknown as typeof fetch;

const { fetchPackument } = await import("../src/pkgCache.ts");
const PKG = "https://registry.npmjs.org/pkg";
const HOUR = 60 * 60 * 1000;
/** A cached packument fetched `age` ms ago, listing only 1.0.0 (2.0.0 came out since). */
const cached = (age: number, body = JSON.stringify({ name: "pkg", versions: { "1.0.0": {} } })) =>
  entries.set(PKG, new Response(body, { headers: { "x-bwc-fetched": String(Date.now() - age) } }));
const versions = (doc: unknown) => Object.keys((doc as { versions: object }).versions);

cached(HOUR);
fetches = 0;
eq("an exact version a stale packument lists comes from the cache", versions(await fetchPackument("pkg", "1.0.0")), ["1.0.0"]);
eq("without a fetch", fetches, 0);

cached(HOUR);
fetches = 0;
eq("an exact version it doesn't list is fetched", versions(await fetchPackument("pkg", "2.0.0")), ["1.0.0", "2.0.0"]);
eq("once", fetches, 1);

for (const range of ["^1.0.0", "latest", "1.0", "=1.0.0"]) {
  cached(HOUR);
  fetches = 0;
  await fetchPackument("pkg", range);
  eq(`a stale packument is fetched again for ${range}`, fetches, 1);
}

cached(HOUR);
fetches = 0;
await fetchPackument("pkg");
eq("and without a range", fetches, 1);

cached(60 * 1000);
fetches = 0;
await fetchPackument("pkg", "^1.0.0");
eq("a fresh one serves a range", fetches, 0);

cached(HOUR, "{not json");
fetches = 0;
eq("a cache entry that doesn't parse is fetched again", versions(await fetchPackument("pkg", "1.0.0")), ["1.0.0", "2.0.0"]);

// An install whose first range for pkg is the pinned 1.0.0 resolves against the stale packument; a dependency's
// "^1.1.0" (1.1.0 came out since) finds no version in it, so pkg is fetched again, once, and 1.1.0 installs.
const { resolveProject } = await import("../src/lockfileWrite.ts");
const docs: Record<string, object> = {
  pkg: { "dist-tags": { latest: "1.1.0" }, versions: { "1.0.0": { name: "pkg", version: "1.0.0" }, "1.1.0": { name: "pkg", version: "1.1.0" } } },
  dep: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "dep", version: "1.0.0", dependencies: { pkg: "^1.1.0" } } } },
};
const asked: string[] = [];
globalThis.fetch = (async (url: string) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  asked.push(name);
  return new Response(JSON.stringify(docs[name]));
}) as unknown as typeof fetch;
cached(HOUR);
const resolved = await resolveProject(
  { name: "app", dependencies: { pkg: "1.0.0", dep: "1.0.0" } },
  {
    semver: { satisfies: Bun.semver.satisfies, order: (a, b) => Bun.semver.order(a, b) },
    packument: async (name, range) => (await fetchPackument(name, range)) as never,
    tarball: async () => {
      throw new Error("no tarballs here");
    },
    folder: () => undefined,
    packageDirs: () => [],
    version: async () => ({}),
  },
);
eq("a later range the stale packument can't satisfy resolves", resolved.problems, []);
const pkgs = new Set(resolved.tree.flatMap((n) => [...n.placed.values()].map((p) => `${p.name}@${p.resolution}`)));
eq("to the version published since", [...pkgs].sort(), ["dep@1.0.0", "pkg@1.0.0", "pkg@1.1.0"]);
eq("after fetching pkg once", asked.sort(), ["dep", "pkg"]);

if (bad) process.exit(1);
console.log("packument cache: ok");
process.exit(0);
