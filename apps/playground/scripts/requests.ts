// The embed's `requests` parser (src/embed/requests.ts) on what authors write, malformed entries included.
// Run with bun: `bun scripts/requests.ts`. Exits 1 on a mismatch.
import { parseRequests } from "../src/embed/requests.ts";
const r = (method: string, path: string, body = "", headers?: [string, string][]) => ({ method, path, body, ...(headers ? { headers } : {}) });
const cases: [string, ReturnType<typeof parseRequests>, number?][] = [
  // [list, presets, warnings]
  ["GET /user/1; GET /user/617; POST /form {\"hello\":\"Elysia\"}", [r("GET", "/user/1"), r("GET", "/user/617"), r("POST", "/form", '{"hello":"Elysia"}')]],
  ["GET /", [r("GET", "/")]],
  ["", []],
  ["  GET   /a?x=1  ;POST /b   body with spaces  ", [r("GET", "/a?x=1"), r("POST", "/b", "body with spaces")]],
  // A `;` in a body splits only before METHOD /path.
  ['POST /sql SELECT 1; SELECT 2; GET /next', [r("POST", "/sql", "SELECT 1; SELECT 2"), r("GET", "/next")]],
  ['POST /json {"a":"x; GET y"}', [r("POST", "/json", '{"a":"x; GET y"}')]],
  ['POST /json {"a":"x; GET /y"}', [r("POST", "/json", '{"a":"x'), r("GET", "/y\"}")]], // the documented limit: `; GET /` splits
  ["POST /multi line\n  two", [r("POST", "/multi", "line\n  two")]],
  // Malformed: lowercase method, no path, a path without `/`, a lone method; the others stay.
  ["get /a; GET /b", [r("GET", "/b")], 1],
  ["GET; GET /b", [r("GET", "/b")], 1],
  ["GET a; DELETE /b", [r("DELETE", "/b")], 1],
  ["/path", [], 1],
  ["GET /a;", [r("GET", "/a;")]],
  // Headers: -H and a quoted `Name: value`, before the body.
  ['GET /me -H "Authorization: Bearer t0k"', [r("GET", "/me", "", [["Authorization", "Bearer t0k"]])]],
  [`POST /form -H 'X-A: 1' -H "Cookie: a=1; b=2" {"a":1}; GET /b`, [r("POST", "/form", '{"a":1}', [["X-A", "1"], ["Cookie", "a=1; b=2"]]), r("GET", "/b")]],
  ['POST /x -H "nocolon" body', [r("POST", "/x", "body")], 1],
  ['POST /x body -H "X: 1"', [r("POST", "/x", 'body -H "X: 1"')]], // after the body, it's the body
];
let bad = 0;
for (const [list, want, warns = 0] of cases) {
  const seen: unknown[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a);
  const got = parseRequests(list);
  console.warn = warn;
  if (JSON.stringify(got) !== JSON.stringify(want) || seen.length !== warns) {
    bad++;
    console.log("DIFF", JSON.stringify(list), "\n want", JSON.stringify(want), warns, "\n got ", JSON.stringify(got), seen.length);
  }
}
console.log(bad ? `requests: ${bad} differences` : `requests: all ${cases.length} match`);
if (bad) process.exit(1);
