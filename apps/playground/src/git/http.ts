// git.wasm's HTTP (crates/git-wasm/src/http.rs, NOTES.md "Network"): imports in the module `runbun` that send a
// request, wait for its headers, then read its body in chunks, all blocking, as git.wasm is. The git worker
// (worker.ts) serves them, through the playground's git proxy (worker/gitProxy.ts: git hosts send no CORS headers):
//
// - `pageChannel`: with SharedArrayBuffer (a cross-origin isolated page), the page fetches, streaming, and hands each
//   chunk over through shared memory while the worker waits on it (Atomics.wait). git.wasm indexes the pack while it
//   downloads, and the page counts the bytes for its progress display.
// - `syncXhr`: otherwise, one synchronous XMLHttpRequest (a worker may make one) brings the whole response at once.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An open response: its status and headers, and its body read chunk by chunk (null at the end, a string on failure). */
export type Conn = { status: number; headers: string; read(max: number): Uint8Array | null | string; close(): void };
/** Sends a request (git's head: `METHOD URL\n` and header lines, and its body) and waits for the response's start. */
export type Transport = (head: string, body: Uint8Array) => Conn | string;

/** The `runbun` import module over `transport`; `progress` gets git.wasm's lines about what it's doing. */
export function httpImports(memory: () => WebAssembly.Memory, transport: Transport, progress: (text: string) => void = () => {}) {
  const open = new Map<number, Conn | { failed: Uint8Array }>();
  let handles = 0;
  const bytes = () => new Uint8Array(memory().buffer);
  return {
    http_request(head: number, headLen: number, body: number, bodyLen: number, out: number) {
      let c: Conn | string;
      try {
        c = transport(dec.decode(bytes().slice(head, head + headLen)), bytes().slice(body, body + bodyLen));
      } catch (e) {
        c = String(e instanceof Error ? e.message : e);
      }
      const h = ++handles;
      const dv = new DataView(memory().buffer);
      dv.setUint32(out + 8, h, true);
      if (typeof c === "string") {
        const failed = enc.encode(c);
        open.set(h, { failed });
        dv.setUint32(out + 4, failed.length, true);
        return 1;
      }
      open.set(h, c);
      dv.setUint32(out, c.status, true);
      dv.setUint32(out + 4, enc.encode(c.headers).length, true);
      return 0;
    },
    http_headers(h: number, buf: number) {
      const c = open.get(h);
      if (!c) return 1;
      bytes().set("failed" in c ? c.failed : enc.encode(c.headers), buf);
      return 0;
    },
    http_body(h: number, buf: number, len: number) {
      const c = open.get(h);
      if (!c || "failed" in c) return -1;
      const chunk = c.read(len);
      if (chunk === null) return 0;
      if (typeof chunk === "string") return -1;
      bytes().set(chunk, buf);
      return chunk.length;
    },
    http_close(h: number) {
      const c = open.get(h);
      open.delete(h);
      if (c && !("failed" in c)) c.close();
    },
    progress(text: number, len: number) {
      progress(dec.decode(bytes().slice(text, text + len)));
    },
  };
}

type Request = { method: string; url: string; headers: [string, string][] } | string;

/** git's request head as a request to the proxy at `proxy` (`…/git-proxy/`), or why it can't go. */
function toProxy(proxy: string, head: string): Request {
  const [first, ...lines] = head.split("\n").filter(Boolean);
  const [method, url] = first.split(" ");
  const u = new URL(url);
  if (u.protocol !== "https:") return `only https:// remotes work in the playground, not ${u.protocol}//`;
  if (u.username || u.password) return "the playground doesn't send credentials in a remote's URL";
  const headers: [string, string][] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    const name = line.slice(0, i).trim();
    // The browser sets its own User-Agent (and refuses it); the proxy sends git's.
    if (i > 0 && name.toLowerCase() !== "user-agent") headers.push([name, line.slice(i + 1).trim()]);
  }
  return { method, url: `${proxy}${u.hostname}${u.pathname}${u.search}`, headers };
}

/** A refusal by the proxy itself (plain text), said as git's error. */
const refusal = (status: number, type: string | null, body: Uint8Array) => (status >= 400 && type?.startsWith("text/plain") ? dec.decode(body).trim() + ` (HTTP ${status})` : null);

/** One synchronous XMLHttpRequest per request: the whole body at once (no shared memory needed). */
export function syncXhr(proxy: string): Transport {
  return (head, body) => {
    const req = toProxy(proxy, head);
    if (typeof req === "string") return req;
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, false);
    xhr.responseType = "arraybuffer";
    for (const [k, v] of req.headers) xhr.setRequestHeader(k, v);
    try {
      xhr.send(req.method === "POST" ? (body as Uint8Array<ArrayBuffer>) : null);
    } catch (e) {
      return `couldn't reach the git proxy: ${e instanceof Error ? e.message : e}`;
    }
    if (xhr.status === 0) return "couldn't reach the git proxy, you may be offline";
    const data = new Uint8Array(xhr.response as ArrayBuffer);
    const refused = refusal(xhr.status, xhr.getResponseHeader("content-type"), data);
    if (refused) return refused;
    let at = 0;
    return {
      status: xhr.status,
      headers: xhr.getAllResponseHeaders().replace(/\r\n/g, "\n"),
      read: (max) => (at >= data.length ? null : data.subarray(at, (at += max))),
      close() {},
    };
  };
}

// --- the page channel ------------------------------------------------------------------------------------------------
//
// One SharedArrayBuffer per worker: a header of Int32s, then a data area. The worker posts a request (`HttpAsk`) and
// waits on STATE; the page answers into the buffer and sets STATE. git.wasm is single-threaded, so one ask is out at
// a time.

const STATE = 0; // 0: waiting; 1: answered
const RESULT = 1; // open: the status (0: failed, the message in data); read: the byte count, 0 at the end, -1 failed
const LENGTH = 2; // open: the headers' (or the message's) length in data
const HEAD = 16;
/** The most a read hands over at once. */
export const CHANNEL_DATA = 1 << 20;

export type HttpAsk =
  | { op: "open"; handle: number; method: string; url: string; headers: [string, string][]; body: Uint8Array }
  | { op: "read"; handle: number; max: number }
  | { op: "close"; handle: number };

/** The worker's side: asks the page (`post`) and waits on `sab` for each answer. */
export function pageChannel(proxy: string, sab: SharedArrayBuffer, post: (ask: HttpAsk) => void): Transport {
  const ctl = new Int32Array(sab, 0, HEAD / 4);
  const data = new Uint8Array(sab, HEAD);
  const ask = (a: HttpAsk) => {
    Atomics.store(ctl, STATE, 0);
    post(a);
    Atomics.wait(ctl, STATE, 0);
  };
  let handles = 0;
  return (head, body) => {
    const req = toProxy(proxy, head);
    if (typeof req === "string") return req;
    const handle = ++handles;
    ask({ op: "open", handle, ...req, body });
    const len = Atomics.load(ctl, LENGTH);
    const text = dec.decode(data.slice(0, len));
    const status = Atomics.load(ctl, RESULT);
    if (!status) return text;
    return {
      status,
      headers: text,
      read(max) {
        ask({ op: "read", handle, max: Math.min(max, CHANNEL_DATA) });
        const n = Atomics.load(ctl, RESULT);
        return n < 0 ? "the download broke off" : n === 0 ? null : data.slice(0, n);
      },
      close: () => post({ op: "close", handle }),
    };
  };
}

/**
 * The page's side: answers a worker's asks into `sab` with streaming fetches. `received` gets each chunk's size (for
 * the progress display).
 */
export function servePage(sab: SharedArrayBuffer, received: (bytes: number) => void) {
  const ctl = new Int32Array(sab, 0, HEAD / 4);
  const data = new Uint8Array(sab, HEAD);
  type Open = { reader: ReadableStreamDefaultReader<Uint8Array>; rest: Uint8Array | null; done: boolean };
  const conns = new Map<number, Open>();
  const answer = (result: number, length = 0) => {
    Atomics.store(ctl, RESULT, result);
    Atomics.store(ctl, LENGTH, length);
    Atomics.store(ctl, STATE, 1);
    Atomics.notify(ctl, STATE);
  };
  const say = (text: string, status = 0) => {
    const b = enc.encode(text).subarray(0, CHANNEL_DATA);
    data.set(b);
    answer(status, b.length);
  };
  return async (a: HttpAsk) => {
    if (a.op === "close") {
      const c = conns.get(a.handle);
      conns.delete(a.handle);
      void c?.reader.cancel().catch(() => {});
      return;
    }
    if (a.op === "open") {
      let res: Response;
      try {
        res = await fetch(a.url, { method: a.method, headers: a.headers, body: a.method === "POST" ? (a.body as Uint8Array<ArrayBuffer>) : undefined, credentials: "same-origin" });
      } catch (e) {
        return say(`couldn't reach the git proxy: ${e instanceof Error ? e.message : e}`);
      }
      if (res.status >= 400 && res.headers.get("content-type")?.startsWith("text/plain")) {
        return say(refusal(res.status, res.headers.get("content-type"), new Uint8Array(await res.arrayBuffer())) ?? `HTTP ${res.status}`);
      }
      const reader = res.body!.getReader();
      conns.set(a.handle, { reader, rest: null, done: false });
      let headers = "";
      res.headers.forEach((v, k) => (headers += `${k}: ${v}\n`));
      return say(headers, res.status);
    }
    const c = conns.get(a.handle);
    if (!c) return answer(-1);
    try {
      while (!c.rest?.length && !c.done) {
        const r = await c.reader.read();
        if (r.done) c.done = true;
        else {
          c.rest = r.value;
          received(r.value.length);
        }
      }
    } catch {
      return answer(-1);
    }
    if (!c.rest?.length) return answer(0);
    const n = Math.min(a.max, c.rest.length);
    data.set(c.rest.subarray(0, n));
    c.rest = c.rest.subarray(n);
    answer(n);
  };
}
