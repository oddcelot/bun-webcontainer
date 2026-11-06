/**
 * Requests that keep every header they were made with, as Bun's do. A browser's `new Request()` drops forbidden
 * header names (Cookie, Host, Origin, Referer, Content-Length, Sec-*) from `request.headers`, so a server handed one
 * (`app.handle(new Request(url, { headers: { cookie } }))`) never sees them; a standalone `Headers` keeps them.
 * Each request's `headers` is such a Headers: the init's (or the copied request's), plus what Request adds itself (a
 * form's boundary). `instanceof Request` still holds for the browser's own requests.
 * fetch() and body methods read the browser's own header list, which has the allowed headers the request was made with
 * but neither forbidden ones nor later changes to `request.headers`; withHeaders() hands fetch() the current ones.
 */
export function keepRequestHeaders(NativeRequest: typeof Request): typeof Request {
  class ServerRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof NativeRequest ? input.headers : undefined));
      for (const [k, v] of super.headers) if (!headers.has(k)) headers.set(k, v);
      Object.defineProperty(this, "headers", { value: headers });
    }
    static [Symbol.hasInstance](x: unknown) {
      return x instanceof NativeRequest;
    }
    clone(): Request {
      return Object.defineProperty(super.clone(), "headers", { value: new Headers(this.headers) });
    }
  }
  Object.defineProperty(ServerRequest, "name", { value: "Request" });
  return ServerRequest;
}

/** fetch()'s init for `input`: a kept request's current headers, unless the init brings its own. */
export const withHeaders = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined =>
  input instanceof Request && Object.hasOwn(input, "headers") && init?.headers === undefined ? { ...init, headers: input.headers } : init;
