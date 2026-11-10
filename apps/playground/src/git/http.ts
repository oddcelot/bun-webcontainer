// git.wasm's HTTP (crates/git-wasm/src/http.rs, NOTES.md "Network"): two imports, `runbun.http_request` and
// `runbun.http_read`, that make a request and hand back the whole response. git.wasm blocks on them, so they block
// too: in the git worker (worker.ts) a synchronous XMLHttpRequest, through the playground's git proxy
// (worker/gitProxy.ts), as git hosts send no CORS headers.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A response, or why there is none. */
export type HttpResult = { status: number; headers: Uint8Array; body: Uint8Array } | string;

/** The `runbun` import module over `request`, which gets git's request head (`METHOD URL\n` and header lines) and body. */
export function httpImports(memory: () => WebAssembly.Memory, request: (head: string, body: Uint8Array) => HttpResult) {
  const pending = new Map<number, { headers: Uint8Array; body: Uint8Array }>();
  let handles = 0;
  return {
    http_request(head: number, headLen: number, body: number, bodyLen: number, out: number) {
      const m = new Uint8Array(memory().buffer);
      let r: HttpResult;
      try {
        r = request(dec.decode(m.slice(head, head + headLen)), m.slice(body, body + bodyLen));
      } catch (e) {
        r = String(e instanceof Error ? e.message : e);
      }
      const h = ++handles;
      const dv = new DataView(memory().buffer);
      dv.setUint32(out + 12, h, true);
      if (typeof r === "string") {
        const msg = enc.encode(r);
        pending.set(h, { headers: msg, body: new Uint8Array() });
        dv.setUint32(out, msg.length, true);
        return 1;
      }
      pending.set(h, r);
      dv.setUint32(out, r.status, true);
      dv.setUint32(out + 4, r.headers.length, true);
      dv.setUint32(out + 8, r.body.length, true);
      return 0;
    },
    http_read(h: number, headers: number, body: number) {
      const r = pending.get(h);
      pending.delete(h);
      if (!r) return 1;
      const m = new Uint8Array(memory().buffer);
      m.set(r.headers, headers);
      m.set(r.body, body);
      return 0;
    },
  };
}

/**
 * Requests through the git proxy at `proxy` (`…/git-proxy/`), synchronously: a worker only (a page may not block).
 * `https://github.com/a/b.git/info/refs` goes to `<proxy>github.com/a/b.git/info/refs`.
 */
export function proxied(proxy: string) {
  return (head: string, body: Uint8Array): HttpResult => {
    const [first, ...lines] = head.split("\n").filter(Boolean);
    const [method, url] = first.split(" ");
    const u = new URL(url);
    if (u.protocol !== "https:") return `only https:// remotes work in the playground, not ${u.protocol}//`;
    if (u.username || u.password) return "the playground doesn't send credentials in a remote's URL";
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${proxy}${u.hostname}${u.pathname}${u.search}`, false);
    xhr.responseType = "arraybuffer";
    for (const line of lines) {
      const i = line.indexOf(":");
      const name = line.slice(0, i).trim();
      // The browser sets its own User-Agent (and refuses it here); the proxy sends git's.
      if (i > 0 && name.toLowerCase() !== "user-agent") xhr.setRequestHeader(name, line.slice(i + 1).trim());
    }
    try {
      xhr.send(method === "POST" ? (body as Uint8Array<ArrayBuffer>) : null);
    } catch (e) {
      return `couldn't reach the git proxy: ${e instanceof Error ? e.message : e}`;
    }
    if (xhr.status === 0) return "couldn't reach the git proxy (offline?)";
    // A refusal by the proxy itself is plain text: say it as git's error.
    if (xhr.status >= 400 && xhr.getResponseHeader("content-type")?.startsWith("text/plain")) return dec.decode(new Uint8Array(xhr.response as ArrayBuffer)).trim() + ` (HTTP ${xhr.status})`;
    return { status: xhr.status, headers: enc.encode(xhr.getAllResponseHeaders().replace(/\r\n/g, "\n")), body: new Uint8Array(xhr.response as ArrayBuffer) };
  };
}
