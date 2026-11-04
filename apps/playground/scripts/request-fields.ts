// The request panel's helpers (src/request.ts): the path's query as rows and back, and the headers packed for the
// service worker. Run with bun: `bun scripts/request-fields.ts`. Exits 1 on a mismatch.
import { build, fromAuth, joinCookies, mergeHeaders, modeOf, noAuth, packHeaders, queryOf, sent, unpackHeaders, withQuery, type Draft } from "../src/request.ts";

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

if (bad) process.exit(1);
console.log("request fields: ok");
