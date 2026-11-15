/**
 * Which objects are proxies, which native Bun asks JSC and JavaScript can't (a proxy answers for its target:
 * `Array.isArray`, `instanceof`): `util.types.isProxy`, and `Bun.XML.stringify`, which takes a proxy of an array or a
 * Date for a plain object. The worker's `Proxy` notes every proxy it makes, so this module must run before user code;
 * proxies made before it, or in another realm, go unseen.
 */
const proxies = new WeakSet<object>();
const NativeProxy = Proxy;

// Proxy.revocable, once (the same function on every read, as native), with its name and length.
const revocable = {
  revocable<T extends object>(target: T, handler: ProxyHandler<T>) {
    const r = NativeProxy.revocable(target, handler);
    proxies.add(r.proxy);
    return r;
  },
}.revocable;

globalThis.Proxy = new NativeProxy(NativeProxy, {
  construct(target, args, newTarget) {
    const p = Reflect.construct(target, args, newTarget);
    proxies.add(p);
    return p;
  },
  get: (target, key, receiver) =>
    key === "revocable" ? revocable : Reflect.get(target, key, receiver),
});

export const isProxy = (v: unknown): boolean =>
  typeof v === "object" || typeof v === "function"
    ? v !== null && proxies.has(v)
    : false;
