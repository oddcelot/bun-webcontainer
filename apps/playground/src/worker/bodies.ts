// What a Request's or Response's body was made from, for console.log: Bun prints `Response (5 bytes) { … Blob
// (5 bytes) }` from the body it holds, while a browser body is a stream whose size isn't known. trackBodies()
// wraps the global constructors (and Response.json/redirect/error, clone) to record it. Bodies from elsewhere
// (fetch() results) stay unknown.

export type BodyInfo =
  | { kind: "none" }
  | { kind: "bytes"; size: number; type?: string }
  | { kind: "blob"; blob: Blob }
  | { kind: "stream"; stream: ReadableStream };

const bodies = new WeakMap<object, BodyInfo>();

export const bodyOf = (r: object): BodyInfo | undefined => bodies.get(r);

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

function infoOf(body: unknown): BodyInfo | undefined {
  if (body === undefined || body === null) return { kind: "none" };
  // An empty string makes an empty body (Bun prints no Blob for it).
  if (typeof body === "string") return body ? { kind: "bytes", size: utf8Length(body) } : { kind: "none" };
  if (typeof Blob !== "undefined" && body instanceof Blob) return { kind: "blob", blob: body };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { kind: "bytes", size: body.byteLength };
  if (typeof SharedArrayBuffer !== "undefined" && body instanceof SharedArrayBuffer) return { kind: "bytes", size: body.byteLength };
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return { kind: "bytes", size: utf8Length(body.toString()), type: "application/x-www-form-urlencoded;charset=UTF-8" };
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { kind: "stream", stream: body };
  // FormData: a multipart body whose size depends on a random boundary.
  return undefined;
}

const record = (r: unknown, info: BodyInfo | undefined) => {
  if (info && typeof r === "object" && r !== null) bodies.set(r, info);
  return r;
};

/** Wraps `g.Response` and `g.Request` (whatever they are now) to record bodies; `instanceof` and statics still work. */
export function trackBodies(g: { Response?: typeof Response; Request?: typeof Request }) {
  for (const name of ["Response", "Request"] as const) {
    const C = g[name] as unknown as (new (...a: unknown[]) => object) & Record<string, unknown>;
    if (typeof C !== "function") continue;
    const clone = C.prototype.clone as (this: object) => object;
    try {
      Object.defineProperty(C.prototype, "clone", {
        value: {
          clone(this: object) {
            const c = clone.call(this);
            const info = bodies.get(this);
            return info ? record(c, info.kind === "stream" ? { kind: "stream", stream: (c as Response).body! } : info) : c;
          },
        }.clone,
        writable: true,
        configurable: true,
      });
    } catch {} // not configurable (native Bun, where the corpus runs this too)
    const statics: Record<string, (args: unknown[]) => BodyInfo | undefined> =
      name === "Response"
        ? {
            json: (a) => {
              const s = JSON.stringify(a[0]);
              return s === undefined ? undefined : { kind: "bytes", size: utf8Length(s) };
            },
            redirect: () => ({ kind: "none" }),
            error: () => ({ kind: "none" }),
          }
        : {};
    const wrapped = new Map<string, Function>();
    const proxy: typeof C = new Proxy(C, {
      construct(target, args, newTarget): object {
        const r: object = Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
        if (name === "Response") return record(r, infoOf(args[0])) as object;
        const init = args[1] as RequestInit | undefined;
        const body = init && init.body !== undefined ? init.body : args[0] instanceof C ? bodies.get(args[0] as object) : null;
        return record(r, body && typeof body === "object" && "kind" in body ? body : infoOf(body)) as object;
      },
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (typeof key !== "string" || !(key in statics) || typeof v !== "function") return v;
        let w = wrapped.get(key);
        if (!w) {
          const info = statics[key];
          w = {
            [key](this: unknown, ...args: unknown[]) {
              return record(v.apply(this === proxy ? target : this, args), info(args));
            },
          }[key];
          wrapped.set(key, w);
        }
        return w;
      },
    });
    g[name] = proxy as never;
  }
}
