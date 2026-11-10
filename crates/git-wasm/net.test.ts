// The network commands (clone, fetch, pull, remote) of target/wasm32-wasip1/release/git.wasm against native git's
// smart-HTTP server (`git http-backend` behind a small CGI server in a child process), with the `runbun` HTTP imports
// served by curl, synchronously, as the playground's worker serves them with a synchronous XMLHttpRequest.
// Native git checks every result. Build first: `moon run git-wasm:build`.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";

const wasm = await WebAssembly.compile(readFileSync(new URL("target/wasm32-wasip1/release/git.wasm", import.meta.url)));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "git-wasm-net-")));
let checks = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `\n${detail}` : ""}`);
};

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LC_ALL: "C", GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@example.com", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@example.com" };
const native = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`native git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const write = (dir: string, path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = join(rel, e.name);
    if (p === ".git") return [];
    return e.isDirectory() ? files(dir, p) : [`${p}=${readFileSync(join(dir, p), "utf8")}`];
  }).sort();
}

// --- the HTTP imports, over curl -------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
let requests: string[] = [];
let progress: string[] = [];
function request(head: string, body: Uint8Array): { status: number; headers: Uint8Array; body: Uint8Array } | string {
  const [first, ...lines] = head.split("\n").filter(Boolean);
  const [method, url] = first.split(" ");
  requests.push(`${method} ${new URL(url).pathname}${new URL(url).search}`);
  const [hf, bf, inf] = [join(tmp, "curl-headers"), join(tmp, "curl-body"), join(tmp, "curl-in")];
  writeFileSync(inf, body);
  const args = ["-s", "-X", method, "-D", hf, "-o", bf, "-w", "%{http_code}", ...lines.flatMap((h) => ["-H", h])];
  if (method === "POST") args.push("--data-binary", `@${inf}`);
  const r = spawnSync("curl", [...args, url], { encoding: "utf8" });
  if (r.status !== 0) return `curl failed: ${r.stderr}`;
  const headers = readFileSync(hf, "utf8").split("\r\n").slice(1).filter(Boolean).join("\n") + "\n";
  return { status: Number(r.stdout), headers: enc.encode(headers), body: readFileSync(bf) };
}

type Run = { code: number; out: string; err: string };
async function git(dir: string, ...args: string[]): Promise<Run> {
  const [outPath, errPath] = [join(tmp, "stdout"), join(tmp, "stderr")];
  const [outFd, errFd] = [openSync(outPath, "w"), openSync(errPath, "w")];
  try {
    const wasi = new WASI({ version: "preview1", args: ["git", ...args], env: {}, preopens: { "/": dir }, stdout: outFd, stderr: errFd, returnOnExit: true });
    let memory!: WebAssembly.Memory;
    // As the playground's worker serves them: headers first, then the body in small chunks (so reads span several).
    const open = new Map<number, { headers: Uint8Array; body: Uint8Array; at: number }>();
    let handles = 0;
    const runbun = {
      http_request(head: number, headLen: number, body: number, bodyLen: number, out: number) {
        const m = new Uint8Array(memory.buffer);
        const r = request(dec.decode(m.slice(head, head + headLen)), m.slice(body, body + bodyLen));
        const dv = new DataView(memory.buffer);
        const h = ++handles;
        dv.setUint32(out + 8, h, true);
        if (typeof r === "string") {
          open.set(h, { headers: enc.encode(r), body: new Uint8Array(), at: 0 });
          dv.setUint32(out + 4, enc.encode(r).length, true);
          return 1;
        }
        open.set(h, { ...r, at: 0 });
        dv.setUint32(out, r.status, true);
        dv.setUint32(out + 4, r.headers.length, true);
        return 0;
      },
      http_headers(h: number, buf: number) {
        new Uint8Array(memory.buffer).set(open.get(h)!.headers, buf);
        return 0;
      },
      http_body(h: number, buf: number, len: number) {
        const r = open.get(h)!;
        const n = Math.min(len, 4096, r.body.length - r.at);
        new Uint8Array(memory.buffer).set(r.body.subarray(r.at, r.at + n), buf);
        r.at += n;
        return n;
      },
      http_close(h: number) {
        open.delete(h);
      },
      progress(text: number, len: number) {
        progress.push(dec.decode(new Uint8Array(memory.buffer).slice(text, text + len)));
      },
    };
    const instance = await WebAssembly.instantiate(wasm, { ...(wasi.getImportObject() as WebAssembly.Imports), runbun });
    memory = instance.exports.memory as WebAssembly.Memory;
    const code = wasi.start(instance) as number;
    return { code, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

// --- a smart-HTTP server: git http-backend as CGI ----------------------------------------------------------------------

const root = join(tmp, "srv");
mkdirSync(root);
const server = spawn(process.execPath, ["-e", `
const http = require("node:http");
const { spawn } = require("node:child_process");
const s = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const cgi = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: ${JSON.stringify(root)}, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"] || "", GIT_PROTOCOL: req.headers["git-protocol"] || "" } });
  req.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on("data", (c) => chunks.push(c));
  cgi.on("close", () => {
    const all = Buffer.concat(chunks);
    const end = all.indexOf("\\r\\n\\r\\n");
    const head = all.subarray(0, end).toString().split("\\r\\n");
    let status = 200;
    const headers = {};
    for (const l of head) { const i = l.indexOf(":"); const k = l.slice(0, i), v = l.slice(i + 1).trim(); if (k.toLowerCase() === "status") status = parseInt(v); else headers[k] = v; }
    res.writeHead(status, headers);
    res.end(all.subarray(end + 4));
  });
});
s.listen(0, "127.0.0.1", () => console.log(s.address().port));
`], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<number>((resolve) => server.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
const base = `http://127.0.0.1:${port}`;

try {
  // upstream: three commits on main, a dev branch, a tag
  const work = join(tmp, "work");
  mkdirSync(work);
  native(work, "init", "-b", "main");
  for (const [i, f] of ["a.txt", "dir/b.txt", "c.txt"].entries()) {
    write(work, f, `v${i}\n`);
    native(work, "add", "-A");
    native(work, "commit", "-m", `c${i}`);
  }
  native(work, "tag", "v1");
  native(work, "switch", "-c", "dev");
  write(work, "dev.txt", "dev\n");
  native(work, "add", "-A");
  native(work, "commit", "-m", "dev");
  native(work, "switch", "main");
  execFileSync("git", ["clone", "--bare", "-q", work, join(root, "repo.git")], { env });
  const url = `${base}/repo.git`;

  // clone
  const a = join(tmp, "a");
  mkdirSync(a);
  progress = [];
  let r = await git(a, "clone", url);
  check("clone exits 0", r.code === 0, JSON.stringify(r));
  check("clone reports progress", progress.includes("Connecting to 127.0.0.1") && progress.includes("Checking out 3 files"), progress.join("\n"));
  check("clone used smart HTTP (protocol v2 POST)", requests.some((q) => q.startsWith("POST /repo.git/git-upload-pack")), requests.join("\n"));
  check("clone files", JSON.stringify(files(a)) === JSON.stringify(files(work)), `${files(a)}\n${files(work)}`);
  check("clone HEAD on main", native(a, "symbolic-ref", "HEAD").trim() === "refs/heads/main");
  check("clone log", native(a, "log", "--format=%s").trim() === "c2\nc1\nc0");
  check("clone origin/dev", native(a, "rev-parse", "origin/dev").trim() === native(work, "rev-parse", "dev").trim());
  check("clone upstream config", native(a, "config", "branch.main.remote").trim() === "origin", native(a, "config", "--list"));
  check("clone native status clean", native(a, "status", "--porcelain") === "");
  r = await git(a, "status", "--porcelain");
  check("clone our status clean", r.code === 0 && r.out === "", JSON.stringify(r));
  native(a, "fsck", "--full", "--strict");
  check("clone fsck", true);
  r = await git(a, "remote", "-v");
  check("remote -v", r.out === `origin\t${url} (fetch)\norigin\t${url} (push)\n`, JSON.stringify(r));

  // a shallow clone, of another branch
  const b = join(tmp, "b");
  mkdirSync(b);
  r = await git(b, "clone", "--depth", "1", "-b", "dev", url);
  check("shallow clone exits 0", r.code === 0, JSON.stringify(r));
  check("shallow: one commit", native(b, "rev-list", "--count", "HEAD").trim() === "1");
  check("shallow: .git/shallow", existsSync(join(b, ".git/shallow")));
  check("shallow: on dev", native(b, "symbolic-ref", "HEAD").trim() === "refs/heads/dev");
  check("shallow: dev.txt", readFileSync(join(b, "dev.txt"), "utf8") === "dev\n");
  native(b, "fsck", "--full");

  // fetch and pull after upstream moved on
  write(work, "a.txt", "v3\n");
  native(work, "commit", "-am", "c3");
  native(work, "push", "-q", join(root, "repo.git"), "main");
  requests = [];
  r = await git(a, "fetch");
  check("fetch exits 0", r.code === 0, JSON.stringify(r));
  check("fetch reports the update", /From .*repo\.git\n\s+[0-9a-f]{7}\.\.[0-9a-f]{7}\s+main\s+-> origin\/main/.test(r.err), r.err);
  check("fetch moved origin/main", native(a, "rev-parse", "origin/main").trim() === native(work, "rev-parse", "main").trim());
  check("fetch left main", native(a, "log", "-1", "--format=%s", "main").trim() === "c2");
  r = await git(a, "pull");
  check("pull exits 0", r.code === 0, JSON.stringify(r));
  check("pull fast-forwarded", native(a, "log", "-1", "--format=%s").trim() === "c3" && readFileSync(join(a, "a.txt"), "utf8") === "v3\n", JSON.stringify(r));
  check("pull: status clean", native(a, "status", "--porcelain") === "");
  r = await git(a, "pull");
  check("pull again: up to date", r.code === 0 && r.out.includes("Already up to date."), JSON.stringify(r));
  native(a, "fsck", "--full", "--strict");

  // pull refuses what isn't a fast-forward
  write(a, "local.txt", "mine\n");
  native(a, "add", "-A");
  native(a, "commit", "-m", "local");
  write(work, "c.txt", "v4\n");
  native(work, "commit", "-am", "c4");
  native(work, "push", "-q", join(root, "repo.git"), "main");
  r = await git(a, "pull");
  check("pull diverged: refused", r.code === 1 && r.err.includes("Not possible to fast-forward"), JSON.stringify(r));
  check("pull diverged: main kept", native(a, "log", "-1", "--format=%s").trim() === "local");

  // remote add / remove
  r = await git(a, "remote", "add", "up", url);
  check("remote add", r.code === 0 && native(a, "config", "remote.up.fetch").trim() === "+refs/heads/*:refs/remotes/up/*", JSON.stringify(r));
  r = await git(a, "fetch", "up");
  check("fetch up", r.code === 0 && native(a, "rev-parse", "up/main").trim() === native(work, "rev-parse", "main").trim(), JSON.stringify(r));
  r = await git(a, "remote", "remove", "up");
  check("remote remove", r.code === 0 && !native(a, "remote").includes("up") && spawnSync("git", ["-C", a, "rev-parse", "-q", "--verify", "up/main"], { env }).status !== 0, JSON.stringify(r));

  // push (http-backend refuses anonymous pushes unless http.receivepack is set)
  const bare = join(root, "repo.git");
  const remoteRef = (ref: string) => spawnSync("git", ["-C", bare, "rev-parse", "-q", "--verify", ref], { encoding: "utf8", env }).stdout.trim();
  native(bare, "config", "http.receivepack", "true");
  const upstreamMain = remoteRef("main");
  r = await git(a, "push");
  check("push diverged: rejected", r.code === 1 && /! \[rejected\]\s+main -> main \(non-fast-forward\)/.test(r.err) && r.err.includes("failed to push"), JSON.stringify(r));
  check("push diverged: remote kept", remoteRef("main") === upstreamMain);

  native(a, "switch", "-q", "-c", "feat");
  write(a, "feat/x.txt", "x\n");
  native(a, "add", "-A");
  native(a, "commit", "-q", "-m", "feat");
  requests = [];
  r = await git(a, "push", "-u", "origin", "feat");
  check("push new branch", r.code === 0 && /\* \[new branch\]\s+feat -> feat/.test(r.err), JSON.stringify(r));
  check("push used receive-pack", requests.includes("GET /repo.git/info/refs?service=git-receive-pack") && requests.includes("POST /repo.git/git-receive-pack"), requests.join("\n"));
  check("push new branch: remote has it", remoteRef("feat") === native(a, "rev-parse", "feat").trim());
  check("push -u: upstream", native(a, "config", "branch.feat.merge").trim() === "refs/heads/feat" && r.out.includes("branch 'feat' set up to track 'origin/feat'."), JSON.stringify(r));
  check("push: tracking ref", native(a, "rev-parse", "origin/feat").trim() === remoteRef("feat"));
  native(bare, "fsck", "--full", "--strict");
  check("push: remote fsck", true);

  write(a, "feat/x.txt", "x2\n");
  native(a, "commit", "-q", "-am", "feat 2");
  r = await git(a, "push");
  check("push fast-forward", r.code === 0 && /[0-9a-f]{7}\.\.[0-9a-f]{7}\s+feat -> feat/.test(r.err) && remoteRef("feat") === native(a, "rev-parse", "feat").trim(), JSON.stringify(r));
  r = await git(a, "push");
  check("push again: up to date", r.code === 0 && r.err.includes("Everything up-to-date"), JSON.stringify(r));

  r = await git(a, "push", "-f", "origin", "main");
  check("push --force", r.code === 0 && /\+ [0-9a-f]{7}\.\.\.[0-9a-f]{7}\s+main -> main \(forced update\)/.test(r.err) && remoteRef("main") === native(a, "rev-parse", "main").trim(), JSON.stringify(r));
  native(bare, "fsck", "--full", "--strict");

  r = await git(a, "push", "origin", "--delete", "feat");
  check("push --delete", r.code === 0 && /- \[deleted\]\s+feat/.test(r.err) && remoteRef("feat") === "", JSON.stringify(r));
  check("push --delete: tracking ref gone", spawnSync("git", ["-C", a, "rev-parse", "-q", "--verify", "origin/feat"], { env }).status !== 0);
  native(a, "switch", "-q", "main");

  // from the shallow clone: only the new commit goes
  write(b, "dev.txt", "dev 2\n");
  native(b, "commit", "-q", "-am", "dev 2");
  r = await git(b, "push", "origin", "dev");
  check("push from a shallow clone", r.code === 0 && remoteRef("dev") === native(b, "rev-parse", "dev").trim(), JSON.stringify(r));
  native(bare, "fsck", "--full", "--strict");

  // into an empty repository: everything goes
  execFileSync("git", ["init", "--bare", "-q", join(root, "empty.git")], { env });
  native(join(root, "empty.git"), "config", "http.receivepack", "true");
  r = await git(a, "remote", "add", "empty", `${base}/empty.git`);
  r = await git(a, "push", "empty", "main");
  check("push into an empty repo", r.code === 0 && /\[new branch\]\s+main -> main/.test(r.err), JSON.stringify(r));
  native(join(root, "empty.git"), "fsck", "--full", "--strict");
  check("push into an empty repo: same history", native(join(root, "empty.git"), "rev-list", "--count", "main").trim() === native(a, "rev-list", "--count", "main").trim());
  native(a, "remote", "remove", "empty");

  // refusals
  r = await git(a, "clone", url);
  check("clone into a project with files", r.code === 128 && r.err.includes("already exists and is not an empty directory"), JSON.stringify(r));
  const c = join(tmp, "c");
  mkdirSync(join(c, "node_modules/x"), { recursive: true });
  writeFileSync(join(c, "node_modules/x/i.js"), "x");
  r = await git(c, "clone", `${base}/missing.git`);
  check("clone a missing repo fails", r.code === 128 && /not found|404/i.test(r.err), JSON.stringify(r));
  check("failed clone leaves no .git, keeps node_modules", !existsSync(join(c, ".git")) && existsSync(join(c, "node_modules/x/i.js")));
  r = await git(c, "clone", url);
  check("clone next to node_modules", r.code === 0 && native(c, "rev-parse", "HEAD").trim() === remoteRef("main"), JSON.stringify(r));
} finally {
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.log(failures.map((f) => `✗ ${f}`).join("\n\n"));
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
