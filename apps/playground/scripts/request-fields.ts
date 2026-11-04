// The request panel's helpers (src/request.ts): the path's query as rows and back, and the headers packed for the
// service worker. Run with bun: `bun scripts/request-fields.ts`. Exits 1 on a mismatch.
import { joinCookies, mergeHeaders, packHeaders, queryOf, sent, unpackHeaders, withQuery } from "../src/request.ts";

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

if (bad) process.exit(1);
console.log("request fields: ok");
