// Requests keep the headers they were made with (src/worker/requestHeaders.ts): a browser drops Cookie, Host, Origin,
// Referer and Content-Length from `request.headers`, so an app tested with `app.handle(new Request(url, { headers:
// { cookie } }))` never saw its cookies, though it does under Bun. Bun keeps them, so BrowserRequest below drops them
// the way a browser does. Run with bun: `bun scripts/request-headers.ts`. Exits 1 on a mismatch.
import { keepRequestHeaders, withHeaders } from "../src/worker/requestHeaders.ts";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};

const FORBIDDEN = new Set(["cookie", "host", "origin", "referer", "content-length"]);
class GuardedHeaders extends Headers {
  set(k: string, v: string) {
    if (!FORBIDDEN.has(k.toLowerCase())) super.set(k, v);
  }
  append(k: string, v: string) {
    if (!FORBIDDEN.has(k.toLowerCase())) super.append(k, v);
  }
}
const guarded = new WeakMap<Request, Headers>();
/** Bun's Request behind a browser's "request" header guard. */
class BrowserRequest extends Request {
  get headers(): Headers {
    let h = guarded.get(this);
    if (!h) {
      guarded.set(this, (h = new GuardedHeaders()));
      for (const [k, v] of super.headers) h.append(k, v);
    }
    return h;
  }
  clone(): Request {
    return Object.setPrototypeOf(super.clone(), BrowserRequest.prototype);
  }
}

const KeptRequest = keepRequestHeaders(BrowserRequest);
const url = "http://localhost/";
const sent = { cookie: "visit=3", host: "example.com", origin: "http://o", referer: "http://o/r", "content-length": "5", "x-a": "1" };
const names = (h: Headers) => [...h.keys()];
const make = () => new KeptRequest(url, { method: "POST", headers: sent, body: "hello" });

eq("the guard drops them without the fix", new BrowserRequest(url, { headers: sent }).headers.get("cookie"), null);
eq("constructor", names(new KeptRequest(url, { headers: sent }).headers), ["content-length", "cookie", "host", "origin", "referer", "x-a"]);
eq("iteration", [...new KeptRequest(url, { headers: { cookie: "a=1" } }).headers], [["cookie", "a=1"]]);
eq("clone()", make().clone().headers.get("cookie"), "visit=3");
eq("new Request(request)", new KeptRequest(make()).headers.get("cookie"), "visit=3");
eq("new Request(request, init) without headers", new KeptRequest(make(), { method: "PUT" }).headers.get("cookie"), "visit=3");
eq("new Request(request, { headers }) replaces them", [...new KeptRequest(make(), { headers: { cookie: "b=2" } }).headers], [["cookie", "b=2"]]);
const late = new KeptRequest(url);
late.headers.set("cookie", "late=1");
eq("headers.set after construction", late.headers.get("cookie"), "late=1");

const form = new FormData();
form.set("a", "1");
const posted = new KeptRequest(url, { method: "POST", body: form, headers: { cookie: "k=1" } });
eq("a form's boundary is added", posted.headers.get("content-type")?.startsWith("multipart/form-data; boundary="), true);
eq("the form still parses", (await posted.formData()).get("a"), "1");
const c = make();
eq("bodies survive clone()", [await c.clone().text(), await c.text()], ["hello", "hello"]);
eq("a copy takes the body", await new KeptRequest(make()).text(), "hello");

eq("instanceof Request", make() instanceof KeptRequest && make() instanceof Request, true);
eq("a browser's own request is one too", new BrowserRequest(url) instanceof KeptRequest, true);
eq("its name", KeptRequest.name, "Request");

const changed = make();
changed.headers.set("x-late", "2");
eq("fetch() gets the current headers", new Headers(withHeaders(changed)?.headers).get("x-late"), "2");
eq("fetch()'s own init headers win", withHeaders(changed, { headers: { "x-b": "1" } })?.headers, { "x-b": "1" });
const plain = new Request(url);
eq("a request without kept headers goes as it is", withHeaders(plain), undefined);

if (bad) {
  console.error(`${bad} mismatch(es)`);
  process.exit(1);
}
console.log("request headers: ok");
