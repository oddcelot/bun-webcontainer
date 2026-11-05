import { bucket, cacheEntry, needsRestamp, trimCache, type Bucket } from "./storage";
import { jsxKey, transpile, transpilerId, type Resolver, type TsconfigFlags } from "./transpiler";

/** Below this, transpiling (~15 ms/MB) is about as fast as hashing and a cache lookup. */
const MIN_SIZE = 256 * 1024;

/**
 * Transpiled code with a token where each import specifier goes. Where a specifier resolves depends on the rest of
 * the project (what's installed, the target), so the tokens are filled in on every use and only the transpiling,
 * which depends on the file alone, is cached.
 */
type Entry = { code: string; specs: string[]; nonce: string };

const memory = new Map<string, Entry>();
let store: Promise<{ b: Bucket; cache: Cache } | undefined> | undefined;
// Its own best-effort bucket where there are Storage Buckets: the browser can drop it without touching projects.
// Elsewhere it shares the origin's storage, and trimCache keeps it within a budget.
const openStore = () =>
  (store ??= bucket("build-cache", { durability: "relaxed" })
    .then(async (b) => ({ b, cache: await b.caches.open("transpile") }))
    .catch(() => undefined));

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function save({ b, cache }: { b: Bucket; cache: Cache }, url: string, e: Entry) {
  const put = cache.put(url, cacheEntry(JSON.stringify(e), { "content-type": "application/json" }));
  void put.then(() => trimCache(b, cache)).catch(() => {});
}

/**
 * `transpile`, cached in memory and in Cache Storage (so a reload doesn't transpile node_modules again), keyed by the
 * transpiler build, path, tsconfig options (decorators, JSX) and source.
 */
export async function transpileCached(source: string, path: string, tsconfig: TsconfigFlags, resolve: Resolver, metaRequire = false, sourceMap = false): Promise<string> {
  if (source.length < MIN_SIZE) return transpile(source, path, tsconfig, resolve, metaRequire, sourceMap);
  const flags = `${tsconfig.experimentalDecorators ? 1 : 0}${tsconfig.emitDecoratorMetadata ? 1 : 0}${metaRequire ? 1 : 0}${sourceMap ? 1 : 0}\0${jsxKey(tsconfig)}`;
  const key = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${await transpilerId()}\0${path}\0${flags}\0${source}`)));
  const url = new URL(`__transpile/${key}`, location.href).href;
  let e = memory.get(key);
  if (!e) {
    const s = await openStore();
    const hit = await s?.cache.match(url).catch(() => undefined);
    e = hit ? ((await hit.json()) as Entry) : undefined;
    if (hit && e && s && needsRestamp(s.b, hit)) save(s, url, e);
    if (!e) {
      const nonce = crypto.randomUUID().slice(0, 8);
      const specs: string[] = [];
      const code = await transpile(source, path, tsconfig, (spec) => `__bwc${nonce}_${specs.push(spec) - 1}__`, metaRequire, sourceMap);
      e = { code, specs, nonce };
      if (s) save(s, url, e);
    }
    memory.set(key, e);
  }
  const { specs } = e;
  return e.code.replace(new RegExp(`__bwc${e.nonce}_(\\d+)__`, "g"), (_, i: string) => {
    const spec = specs[+i];
    return JSON.stringify(resolve(spec, "stmt") ?? spec).slice(1, -1);
  });
}
