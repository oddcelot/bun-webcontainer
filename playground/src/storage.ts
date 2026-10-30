/**
 * Storage Buckets (Chromium 122+) let the browser evict and persist each bucket on its own. Elsewhere a bucket is
 * the origin's default storage, so everything shares one eviction fate and `persist()` covers the whole origin.
 */
export type Bucket = {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
  /** Asks the browser not to evict this bucket. */
  persist(): Promise<boolean>;
  /** False when this is the origin's default storage (no Storage Buckets). */
  own: boolean;
};

type Options = { durability?: "strict" | "relaxed"; quota?: number; expires?: number };
type StorageBuckets = { open(name: string, options?: Options): Promise<Omit<Bucket, "own">> };

const fallback: Bucket = {
  getDirectory: () => navigator.storage.getDirectory(),
  persist: async () => (await navigator.storage.persist?.()) ?? false,
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
          (b) => ({ getDirectory: () => b.getDirectory(), persist: () => b.persist(), own: true }),
          () => fallback,
        )
      : Promise.resolve(fallback);
    opened.set(name, b);
  }
  return b;
}
