// runbun.json's reader (src/projectConfig.ts readConfig) on what authors write, mistakes included: each case's fields
// as read, and how many problems it reports. Run with bun: `bun scripts/project-config.ts`. Exits 1 on a mismatch.
import { readConfig, type ProjectConfig } from "../src/projectConfig.ts";

const cases: [string, string | undefined, ProjectConfig, number?][] = [
  // [name, file, config, problems]
  ["no file", undefined, {}],
  ["not JSON", "{", {}, 1],
  ["not an object", "[]", {}, 1],
  ["comments and trailing commas", '{\n  // runs\n  "autorun": false, /* off */\n}', { autorun: false }],
  ["unknown field", '{ "autorn": false }', {}, 1],
  ["run", '{ "run": { "entry": "./src/a.ts", "args": ["-v"] } }', { run: { entry: "src/a.ts", args: ["-v"] } }],
  ["run without entry", '{ "run": { "args": [] } }', {}, 1],
  ["env coerces scalars, drops the rest", '{ "env": { "A": "x", "N": 1, "B": true, "O": {} } }', { env: { A: "x", N: "1", B: "true" } }],
  ["readonly: files and folders", '{ "readonly": ["./bun.lock", "vendor/", "/"] }', { readonly: ["bun.lock", "vendor"] }],
  ["readonly not a list", '{ "readonly": "bun.lock" }', {}, 1],
  ["panels",'{ "panels": { "files": true, "preview": false, "nope": true } }', { panels: { files: true, preview: false } }, 1],
  ["layout", '{ "layout": "stack" }', { layout: "stack" }],
  ["layout unknown", '{ "layout": "below" }', {}, 1],
  ["sizes",'{ "sizes": { "files": 20, "editor": 60.5, "preview": 70 } }', { sizes: { files: 20, editor: 60.5, preview: 70 } }],
  ["sizes out of range or unknown", '{ "sizes": { "files": 0, "editor": 100, "preview": "70", "console": 30 } }', { sizes: {} }, 4],
  ["sizes not an object", '{ "sizes": [20] }', {}, 1],
  ["preview", '{ "preview": { "path": "/a", "requests": ["GET /b"] } }', { preview: { path: "/a", requests: ["GET /b"] } }],
  ["requires", '{ "requires": ["local-bun", "gpu"] }', { requires: ["local-bun"] }, 1],
];

let bad = 0;
for (const [name, text, want, problems = 0] of cases) {
  const seen: string[] = [];
  const got = readConfig((path) => (path === "runbun.json" ? text : undefined), seen);
  // Through JSON: fields read as undefined don't count.
  if (JSON.stringify(got) !== JSON.stringify(JSON.parse(JSON.stringify(want))) || seen.length !== problems) {
    bad++;
    console.error(`✗ ${name}\n  want ${JSON.stringify(want)} (${problems} problems)\n  got  ${JSON.stringify(got)} (${seen.length}: ${seen.join("; ")})`);
  }
}
console.log(`${cases.length - bad}/${cases.length} runbun.json cases`);
if (bad) process.exit(1);
