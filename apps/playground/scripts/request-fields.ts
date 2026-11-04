// The request panel's helpers (src/request.ts): the path's query as rows and back, and the headers packed for the
// service worker. Run with bun: `bun scripts/request-fields.ts`. Exits 1 on a mismatch.
import { build, fromAuth, fromHttp, toCurl, toFetch, toHttp, joinCookies, mergeHeaders, modeOf, noAuth, packHeaders, queryOf, sent, unpackHeaders, withQuery, type Draft } from "../src/request.ts";

let bad = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  bad++;
  console.error(`✗ ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
};
const q = (name: string, value = "") => ({ name, value });

eq("no query", queryOf("/a"), []);
eq("query", queryOf("/a?x=1&y=two+words&z"), [q("x", "1"), q("y", "two words"), q("z")]);
eq("fragment left out", queryOf("/a?x=1#y=2"), [q("x", "1")]);
eq("encoded", queryOf("/a?q=%26%3D%2B"), [q("q", "&=+")]);

eq("written", withQuery("/a", [q("x", "1"), q("y", "two words")]), "/a?x=1&y=two+words");
eq("replaced, fragment kept", withQuery("/a?old=1#top", [q("x", "1")]), "/a?x=1#top");
eq("none: no ?", withQuery("/a?x=1", []), "/a");
eq("empty rows left out", withQuery("/a", [q(""), q("x")]), "/a?x");
eq("a value with no name", withQuery("/a", [q("", "v")]), "/a?=v");
eq("readable characters", withQuery("/a", [q("next", "/b/c:d@e,f$")]), "/a?next=/b/c:d@e,f$");
eq("the rest encoded", withQuery("/a", [q("q", "&=+#?")]), "/a?q=%26%3D%2B%23%3F");
for (const path of ["/a?x=1&y=two+words&z", "/a?q=%26%3D%2B%23%3F", "/a?=v&x#f"])
  eq(`round trip ${path}`, queryOf(withQuery(path, queryOf(path))), queryOf(path));

eq(
  "sent: on, named, trimmed",
  sent([
    { name: " Accept ", value: "text/plain", on: true },
    { name: "Cookie", value: "a=1", on: false },
    { name: "  ", value: "x", on: true },
  ]),
  [["Accept", "text/plain"]],
);
const headers: [string, string][] = [["Cookie", "a=1; b=ü"], ["Authorization", "Bearer x"]];
eq("packed round trip", unpackHeaders(packHeaders(headers)), headers);
eq("packed is a header value", /^[\x21-\x7e]*$/.test(packHeaders(headers)), true);
eq("unpack: not packed", unpackHeaders("nope{"), []);
eq("unpack: none", unpackHeaders(null), []);
eq("unpack: wrong shape", unpackHeaders(encodeURIComponent('[["a",1],"b",["c","d"]]')), [["c", "d"]]);
eq(
  "merged over, by name in any case",
  mergeHeaders(
    [
      ["content-type", "text/plain"],
      ["accept", "*/*"],
    ],
    [["Content-Type", "application/xml"]],
  ),
  [
    ["accept", "*/*"],
    ["Content-Type", "application/xml"],
  ],
);
eq("cookies joined", joinCookies("a=1; b=2", "b=3; c=4"), "a=1; b=3; c=4");
eq("cookies: none from the jar", joinCookies(undefined, "c=4"), "c=4");
eq("cookies: none at all", joinCookies(undefined, undefined), "");

eq("mode: JSON", modeOf('{"a":1}'), "json");
eq("mode: empty", modeOf(""), "json");
eq("mode: text", modeOf("a=1"), "text");

const auth = (change: Partial<ReturnType<typeof noAuth>>) => ({ ...noAuth(), ...change });
eq("auth: none", fromAuth(noAuth()), {});
eq("auth: bearer", fromAuth(auth({ type: "bearer", token: " t0k " })), { header: ["Authorization", "Bearer t0k"] });
eq("auth: bearer, no token", fromAuth(auth({ type: "bearer" })), {});
eq("auth: basic, UTF-8", fromAuth(auth({ type: "basic", user: "ü", pass: "p" })), { header: ["Authorization", `Basic ${Buffer.from("ü:p").toString("base64")}`] });
eq("auth: API key header", fromAuth(auth({ type: "apikey", key: "X-Key", value: "k" })), { header: ["X-Key", "k"] });
eq("auth: API key query", fromAuth(auth({ type: "apikey", key: "key", value: "k", in: "query" })), { param: { name: "key", value: "k" } });

const draft = (change: Partial<Draft>): Draft => ({ method: "POST", path: "/a", body: "", bodyMode: "json", form: [], multipart: [], headers: [], auth: noAuth(), ...change });
const none = () => undefined;
const row = (name: string, value: string, on = true, file?: boolean) => ({ name, value, on, file });
eq("GET: no body", build(draft({ method: "GET", body: "x" }), none), { path: "/a", headers: [] });
eq("JSON", build(draft({ body: '{"a":1}' }), none), { path: "/a", headers: [], body: '{"a":1}', type: "application/json" });
eq("text", build(draft({ body: "hi", bodyMode: "text" }), none), { path: "/a", headers: [], body: "hi", type: "text/plain" });
eq("empty body: none", build(draft({}), none), { path: "/a", headers: [] });
eq(
  "form",
  build(draft({ bodyMode: "form", form: [row("a", "1 2"), row("off", "x", false), row("", "nameless"), row("b", "&")] }), none),
  { path: "/a", headers: [], body: "a=1+2&b=%26", type: "application/x-www-form-urlencoded" },
);
eq(
  "auth first, a header row wins",
  build(draft({ auth: auth({ type: "bearer", token: "t" }), headers: [row("authorization", "mine")] }), none).headers,
  [["authorization", "mine"]],
);
eq("auth in the query", build(draft({ path: "/a?x=1", auth: auth({ type: "apikey", key: "key", value: "k", in: "query" }) }), none).path, "/a?x=1&key=k");
const multi = build(draft({ bodyMode: "multipart", multipart: [row("t", "text"), row("f", "/src/a.txt", true, true)] }), (p) => (p === "src/a.txt" ? new TextEncoder().encode("bytes") : undefined));
const form = multi.body as FormData;
eq("multipart: no type (fetch writes it)", multi.type, undefined);
eq("multipart: text", form.get("t"), "text");
eq("multipart: file", [(form.get("f") as File).name, await (form.get("f") as File).text()], ["a.txt", "bytes"]);
let threw = "";
try {
  build(draft({ bodyMode: "multipart", multipart: [row("f", "nope.txt", true, true)] }), none);
} catch (err) {
  threw = String(err);
}
eq("multipart: a missing file", threw, 'Error: No file "nope.txt" in the project for the form field "f"');

// The Raw view: .http text and back.
const raw = draft({ path: "/a?x=1", body: '{"a":1}', headers: [row("X-A", "1"), row("X-Off", "2", false), row("", "")], auth: auth({ type: "bearer", token: "t" }) });
const http = toHttp(raw);
eq("http", http, '# Auth adds the Authorization header (edit it under Auth)\nPOST /a?x=1\nX-A: 1\n# X-Off: 2\n\n{"a":1}');
eq("http read back", fromHttp(http, raw), { headers: [row("X-A", "1"), row("X-Off", "2", false)], method: "POST", path: "/a?x=1", body: '{"a":1}' });
eq("http: GET has no body", toHttp(draft({ method: "GET", body: "x" })), "GET /a");
eq("http: a form's rows stay under Body", toHttp(draft({ bodyMode: "form" })), "POST /a\n\n# The body is the Form rows under Body");
eq("http: the form's comment leaves the rows", fromHttp("POST /a\n\n# The body is the Form rows under Body", { bodyMode: "form" }).bodyMode, undefined);
eq("http: a body over a form makes it JSON or text", fromHttp("POST /a\n\nplain", { bodyMode: "form" }), { headers: [], method: "POST", path: "/a", body: "plain", bodyMode: "text" });
eq("http: a URL, HTTP/1.1, lowercase method", fromHttp("post http://localhost:3000/b?y HTTP/1.1\r\nA:1", { bodyMode: "json" }), { headers: [row("A", "1")], method: "POST", path: "/b?y", body: "" });
eq("http: no request line yet", fromHttp("POS", { bodyMode: "json" }), { headers: [], body: "" });
eq("http: a line that isn't a header is skipped", fromHttp("GET /\nnot a header\nB: 2", { bodyMode: "json" }).headers, [row("B", "2")]);

// Copy as curl and fetch.
eq(
  "curl",
  toCurl(draft({ body: "it's", bodyMode: "text", headers: [row("X-A", "1")] })),
  "curl -X POST 'http://localhost:3000/a' \\\n  -H 'X-A: 1' \\\n  -H 'Content-Type: text/plain' \\\n  --data-raw 'it'\\''s'",
);
eq("curl: GET", toCurl(draft({ method: "GET", auth: auth({ type: "apikey", key: "k", value: "v", in: "query" }) })), "curl 'http://localhost:3000/a?k=v'");
eq(
  "curl: multipart",
  toCurl(draft({ bodyMode: "multipart", multipart: [row("f", "/d/n.txt", true, true), row("t", "@x")] })),
  "curl -X POST 'http://localhost:3000/a' \\\n  -F 'f=@d/n.txt' \\\n  --form-string 't=@x'",
);
eq("curl: a content type row wins", toCurl(draft({ body: "{}", headers: [row("content-type", "application/vnd+json")] })).match(/-H/g)?.length, 1);
eq("fetch: GET", toFetch(draft({ method: "GET" })), 'const res = await fetch("http://localhost:3000/a");');
eq(
  "fetch: JSON",
  toFetch(draft({ body: '{"a":1}' })),
  'const res = await fetch("http://localhost:3000/a", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({"a":1}),\n});',
);
eq(
  "fetch: multipart",
  toFetch(draft({ bodyMode: "multipart", multipart: [row("f", "n.txt", true, true)] })),
  'const form = new FormData();\nform.append("f", Bun.file("n.txt"));\nconst res = await fetch("http://localhost:3000/a", {\n  method: "POST",\n  body: form,\n});',
);

if (bad) process.exit(1);
console.log("request fields: ok");
