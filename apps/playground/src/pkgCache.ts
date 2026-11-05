import { bucket, cachedSize, cacheEntry, needsRestamp, trimCache, type Bucket } from "./storage";

/**
 * npm downloads, kept across projects and reloads like Bun's ~/.bun/install/cache. Tarballs are stored as they come:
 * gunzip and untar are faster than reading the unpacked files back (TypeScript 5.9: 44 ms vs 87 ms; Elysia: 14 vs 96).
 * A best-effort bucket where there are Storage Buckets; elsewhere trimCache keeps it within a budget.
 */
type Bytes = Uint8Array<ArrayBuffer>;
type Store = { b: Bucket; cache: Cache };
let store: Promise<Store | undefined> | undefined;
const open = () =>
  (store ??= bucket("pkg-cache", { durability: "relaxed" })
    .then(async (b) => ({ b, cache: await b.caches.open("npm") }))
    .catch(() => undefined));

/** Like Bun's manifest cache: a packument is used for 5 minutes before it's fetched again. */
const PACKUMENT_TTL = 5 * 60 * 1000;
const FETCHED = "x-bwc-fetched";

function save({ b, cache }: Store, key: string, body: string | Uint8Array, headers?: Record<string, string>) {
  void cache
    .put(key, cacheEntry(body, headers))
    .then(() => trimCache(b, cache))
    .catch(() => {});
}

/**
 * A tarball, from the cache when there: a URL's tarball never changes. `verify` (an integrity check) runs on cached
 * bytes too; a cached copy that fails it is fetched again.
 */
export async function fetchTarball(url: string, verify?: (bytes: Bytes) => Promise<boolean>): Promise<Bytes> {
  const s = await open();
  const hit = await s?.cache.match(url).catch(() => undefined);
  if (s && hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (!verify || (await verify(bytes))) {
      if (needsRestamp(s.b, hit)) save(s, url, bytes);
      return bytes;
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (verify && !(await verify(bytes))) throw new Error("integrity check failed");
  if (s) save(s, url, bytes);
  return bytes;
}

/** A packument (abbreviated, as `bun install` asks for), cached for a few minutes; the cached one when offline. */
export async function fetchPackument(name: string): Promise<unknown> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
  const s = await open();
  const hit = await s?.cache.match(url).catch(() => undefined);
  if (hit && Date.now() - Number(hit.headers.get(FETCHED) ?? 0) < PACKUMENT_TTL) return hit.json();
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
  } catch (e) {
    if (hit) return hit.json();
    throw e;
  }
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const text = await res.text();
  if (s) save(s, url, text, { "content-type": "application/json", [FETCHED]: String(Date.now()) });
  return JSON.parse(text);
}

/** What the cache holds: tarballs and packuments, and about how many bytes. */
export async function pkgCacheInfo(): Promise<{ tarballs: number; packuments: number; bytes: number }> {
  const s = await open();
  const info = { tarballs: 0, packuments: 0, bytes: 0 };
  for (const req of (await s?.cache.keys()) ?? []) {
    if (req.url.endsWith(".tgz")) info.tarballs++;
    else info.packuments++;
    info.bytes += cachedSize(await s!.cache.match(req));
  }
  return info;
}

export async function clearPkgCache(): Promise<void> {
  const s = await open();
  await s?.b.caches.delete("npm");
  store = undefined;
}
