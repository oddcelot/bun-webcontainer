/**
 * Storage Buckets (Chromium 122+) let the browser evict and persist each bucket on its own. Elsewhere a bucket is
 * the origin's default storage, so everything shares one eviction fate and `persist()` covers the whole origin.
 */
export type Bucket = {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
  /** Asks the browser not to evict this bucket. */
  persist(): Promise<boolean>;
  /** Whether the browser has agreed not to evict it. */
  persisted(): Promise<boolean>;
  caches: CacheStorage;
  /** False when this is the origin's default storage (no Storage Buckets). */
  own: boolean;
};

type Options = { durability?: "strict" | "relaxed"; quota?: number; expires?: number };
type StorageBuckets = { open(name: string, options?: Options): Promise<Omit<Bucket, "own">> };

const fallback: Bucket = {
  getDirectory: () => navigator.storage.getDirectory(),
  persist: async () => (await navigator.storage.persist?.()) ?? false,
  persisted: async () => (await navigator.storage.persisted?.()) ?? false,
  get caches() {
    return self.caches;
  },
  own: false,
};

const opened = new Map<string, Promise<Bucket>>();

/** Opens a bucket (names: lowercase letters, digits, `_` and `-`); falls back to default storage if that fails. */
export function bucket(name: string, options?: Options): Promise<Bucket> {
  let b = opened.get(name);
  if (!b) {
    const sb = (navigator as { storageBuckets?: StorageBuckets }).storageBuckets;
    b = sb
      ? sb.open(name, options).then(
          (b) => ({ getDirectory: () => b.getDirectory(), persist: () => b.persist(), persisted: () => b.persisted(), caches: b.caches, own: true }),
          () => fallback,
        )
      : Promise.resolve(fallback);
    opened.set(name, b);
  }
  return b;
}

/**
 * Without Storage Buckets, caches share the origin's eviction fate with projects: when the origin runs short of
 * space, the browser drops everything, saved projects included. So there, caches keep a budget themselves. Each entry
 * is stamped with when it was last used; once the origin's usage passes the budget, the least recently used entries
 * go until usage is back under it, with some room to spare.
 */
const USED = "x-bwc-used";
const SIZE = "x-bwc-size";
/** A hit is stamped again once its stamp is older than this, so reads rarely turn into writes. */
const RESTAMP = 24 * 60 * 60 * 1000;
/** The origin's usage the caches keep under: half of its quota, at most 1 GiB. */
const budget = (quota: number) => Math.min(quota / 2, 2 ** 30);
/** Pruning goes down to this share of the budget, so the next few writes don't prune again. */
const TARGET = 0.8;

/** A response for a cache entry, stamped with the time of use and the size of `body` (about its bytes). */
export function cacheEntry(body: string | Uint8Array, headers: Record<string, string> = {}): Response {
  const size = typeof body === "string" ? body.length : body.byteLength;
  return new Response(body as BodyInit, { headers: { ...headers, [USED]: String(Date.now()), [SIZE]: String(size) } });
}

/** About how many bytes a cache entry made by `cacheEntry` holds. */
export const cachedSize = (r: Response | undefined) => Number(r?.headers.get(SIZE) ?? 0);

/** Whether a hit should be put again to record its use (only without an own bucket, where the budget applies). */
export function needsRestamp(b: Bucket, hit: Response): boolean {
  return !b.own && Date.now() - Number(hit.headers.get(USED) ?? 0) > RESTAMP;
}

const trimming = new Map<Cache, ReturnType<typeof setTimeout>>();

/**
 * Call after putting into `cache`: without an own bucket, prunes its least recently used entries once the origin
 * passes the budget. Runs once a burst of writes has settled.
 */
export function trimCache(b: Bucket, cache: Cache): void {
  if (b.own) return;
  clearTimeout(trimming.get(cache));
  trimming.set(
    cache,
    setTimeout(() => {
      trimming.delete(cache);
      void prune(cache).catch(() => {});
    }, 2000),
  );
}

async function prune(cache: Cache) {
  const { usage = 0, quota = Infinity } = await navigator.storage.estimate();
  const limit = budget(quota);
  if (usage <= limit) return;
  const entries = await Promise.all(
    (await cache.keys()).map(async (req) => {
      const r = await cache.match(req);
      return { req, used: Number(r?.headers.get(USED) ?? 0), size: cachedSize(r) };
    }),
  );
  entries.sort((a, b) => a.used - b.used);
  let over = usage - limit * TARGET;
  for (const e of entries) {
    if (over <= 0) break;
    await cache.delete(e.req);
    over -= e.size;
  }
}
