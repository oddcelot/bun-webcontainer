// Runs target/wasm32-wasip1/release/git.wasm under node's WASI with a temp dir preopened as `/` (cwd `/`), through a
// scripted session, and checks every step against native git: status, log, diff, show, `git fsck --full`.
// Also reads a `git clone --no-local` of this repo (packed objects). Build first: `moon run git-wasm:build`.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";

const wasm = await WebAssembly.compile(readFileSync(new URL("target/wasm32-wasip1/release/git.wasm", import.meta.url)));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "git-wasm-")));
let checks = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `\n${detail}` : ""}`);
}
function same(name: string, ours: string, native: string): void {
  check(name, ours === native, `--- ours\n${ours}\n--- native\n${native}`);
}

type Run = { code: number; out: string; err: string };
async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const [outPath, errPath] = [join(tmp, "stdout"), join(tmp, "stderr")];
  const [outFd, errFd] = [openSync(outPath, "w"), openSync(errPath, "w")];
  try {
    const wasi = new WASI({ version: "preview1", args: ["git", ...args], env, preopens: { "/": dir }, stdout: outFd, stderr: errFd, returnOnExit: true });
    // No network here (net.test.ts has it): a request fails.
    const runbun = { http_request: () => 1, http_headers: () => 0, http_body: () => -1, http_close: () => {}, progress: () => {} };
    const instance = await WebAssembly.instantiate(wasm, { ...(wasi.getImportObject() as WebAssembly.Imports), runbun });
    const code = wasi.start(instance) as number;
    return { code, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}
function native(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_PAGER: "cat", LC_ALL: "C", LANGUAGE: "C" } });
  if (r.status !== 0) throw new Error(`native git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const nativeCode = (dir: string, args: string[]): number => spawnSync("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LC_ALL: "C" } }).status ?? -1;
/** Every file under dir (not .git) with its content, sorted. */
function files(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = join(rel, e.name);
    if (p === ".git") return [];
    return e.isDirectory() ? files(dir, p) : [`${p}=${readFileSync(join(dir, p), "utf8")}`];
  }).sort();
}
const fsck = (dir: string) => {
  try {
    native(dir, ["fsck", "--full", "--strict"]);
    check(`fsck ${dir === project ? "" : "clone"}`, true);
  } catch (e) {
    check("fsck", false, String(e));
  }
};
const write = (dir: string, path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

const project = join(tmp, "project");
mkdirSync(project);
const ident = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com" };
const run = (args: string[], env = ident) => git(project, args, env);

try {
  // init
  let r = await run(["init"]);
  check("init output", r.out === "Initialized empty Git repository in /.git/\n" && r.code === 0, JSON.stringify(r));
  check("init config", native(project, ["config", "core.fileMode"]).trim() === "false");
  check("init exclude", readFileSync(join(project, ".git/info/exclude"), "utf8").includes("node_modules/"));
  check("init branch", readFileSync(join(project, ".git/HEAD"), "utf8").trim() === "ref: refs/heads/main");
  r = await run(["log"]);
  check("log unborn", r.code === 128 && r.err === "fatal: your current branch 'main' does not have any commits yet\n", JSON.stringify(r));

  write(project, "index.ts", "console.log(1);\n");
  write(project, "README.md", "# hi\n");
  write(project, "src/util.ts", "export const a = 1;\nexport const b = 2;\n");
  write(project, "node_modules/dep/index.js", "module.exports = 1;\n");

  r = await run(["status"]);
  check("status unborn", r.out.startsWith("On branch main\n\nNo commits yet\n\nUntracked files:\n") && r.out.includes("\tREADME.md\n\tindex.ts\n\tsrc/\n") && !r.out.includes("node_modules"), r.out);
  same("status -s untracked", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));

  r = await run(["add", "."]);
  check("add .", r.code === 0 && r.out === "" && r.err === "", JSON.stringify(r));
  r = await run(["status"]);
  check("status staged", r.out.includes("Changes to be committed:\n") && r.out.includes("\tnew file:   src/util.ts\n") && !r.out.includes("Untracked"), r.out);
  same("status -s staged", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  same("porcelain staged", (await run(["status", "-s"])).out, native(project, ["status", "--porcelain"]));
  r = await run(["add", "nope"]);
  check("add missing", r.code === 128 && r.err.includes("pathspec 'nope' did not match"), JSON.stringify(r));

  r = await run(["commit", "-m", "first commit"]);
  check("commit root", r.code === 0 && /^\[main \(root-commit\) [0-9a-f]{7}\] first commit\n 3 files changed, 4 insertions\(\+\)\n create mode 100644 README.md\n/.test(r.out), r.out + r.err);
  same("log subject", native(project, ["log", "--format=%an <%ae> %s"]), "Ada <ada@example.com> first commit\n");
  fsck(project);
  r = await run(["commit", "-m", "again"]);
  check("commit empty refused", r.code === 1 && r.out.includes("nothing to commit, working tree clean"), JSON.stringify(r));
  same("status clean", (await run(["status"])).out, "On branch main\nnothing to commit, working tree clean\n");
  same("status clean native", native(project, ["status", "--porcelain"]), "");

  // identity from config beats env
  const hash1 = native(project, ["rev-parse", "HEAD"]).trim();
  same("rev-parse", (await run(["rev-parse", "HEAD"])).out, hash1 + "\n");

  // modify, delete, add new, node_modules, nested new dir, no trailing newline
  write(project, "index.ts", "console.log(2);\nconsole.log(3);\n");
  rmSync(join(project, "README.md"));
  write(project, "new.ts", "export {};");
  write(project, "node_modules/dep/other.js", "x\n");
  write(project, "docs/a.md", "a\n");
  write(project, "docs/b.md", "b\n");
  same("status -s dirty", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  r = await run(["status"]);
  check("status dirty", r.out.includes("Changes not staged for commit:\n") && r.out.includes("\tmodified:   index.ts\n") && r.out.includes("\tdeleted:    README.md\n") && r.out.includes("\tdocs/\n\tnew.ts\n"), r.out);
  same("diff", (await run(["diff"])).out, native(project, ["diff", "--no-color"]));

  r = await run(["add", "-A"]);
  check("add -A", r.code === 0, JSON.stringify(r));
  same("status -s after add -A", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  same("diff --cached", (await run(["diff", "--cached"])).out, native(project, ["diff", "--cached", "--no-color"]));
  same("diff clean worktree", (await run(["diff"])).out, "");

  // unstage and re-stage
  r = await run(["restore", "--staged", "docs"]);
  same("status -s after restore --staged", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  r = await run(["reset"]);
  same("status -s after reset", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  await run(["add", "-A"]);
  r = await run(["rm", "--cached", "new.ts"]);
  check("rm --cached", r.out === "rm 'new.ts'\n", JSON.stringify(r));
  same("status -s after rm --cached", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  await run(["add", "new.ts"]);

  r = await run(["commit", "-m", "second", "-m", "body line"]);
  check("commit", r.code === 0 && /^\[main [0-9a-f]{7}\] second\n 5 files changed, 5 insertions\(\+\), 2 deletions\(-\)\n/.test(r.out) && r.out.includes(" delete mode 100644 README.md\n"), r.out + r.err);
  same("log body", native(project, ["log", "-1", "--format=%B"]), "second\n\nbody line\n\n");
  fsck(project);

  // commit -am: tracked modifications and deletions only
  write(project, "index.ts", "console.log(4);\n");
  rmSync(join(project, "new.ts"));
  write(project, "untracked.ts", "u\n");
  r = await run(["commit", "-am", "third"]);
  check("commit -am", r.code === 0 && r.out.includes("] third\n 2 files changed, 1 insertion(+), 3 deletions(-)\n"), r.out + r.err);
  same("status -s untracked stays", (await run(["status", "-s"])).out, "?? untracked.ts\n");
  same("native status", native(project, ["status", "--porcelain"]), "?? untracked.ts\n");
  fsck(project);

  // log
  same("log --oneline", (await run(["log", "--oneline"])).out, native(project, ["log", "--oneline", "--no-decorate", "--abbrev=7"]));
  same("log -n 2", (await run(["log", "-n", "2", "--oneline"])).out, native(project, ["log", "-2", "--oneline", "--no-decorate", "--abbrev=7"]));
  same("log -1", (await run(["log", "-1"])).out, native(project, ["log", "-1", "--no-color", "--date=default"]));
  same("log full", (await run(["log"])).out, native(project, ["log", "--no-color"]));

  // show, branch
  same("show", (await run(["show"])).out, native(project, ["show", "--no-color", "HEAD"]));
  same("show root", (await run(["show", hash1])).out, native(project, ["show", "--no-color", hash1]));
  await run(["branch", "feature"]);
  same("branch list", (await run(["branch"])).out, "  feature\n* main\n");
  same("native branches", native(project, ["branch", "--format=%(refname:short)"]), "feature\nmain\n");

  // colors, unknown commands
  r = await run(["status", "-s"], { ...ident, GIT_COLOR: "1" });
  check("color", r.out === "\x1b[31m??\x1b[m untracked.ts\n", JSON.stringify(r.out));
  r = await run(["frobnicate"]);
  check("unknown", r.code === 1 && r.err.includes("'frobnicate' is not a git command"), JSON.stringify(r));
  r = await run([]);
  check("usage", r.out.includes("usage: git"));
  r = await git(tmp, ["status"]);
  check("outside repo", r.code === 128 && r.err.startsWith("fatal: not a git repository"), JSON.stringify(r));

  // identity: config user.* wins over env, default without either
  native(project, ["config", "user.name", "Grace"]);
  native(project, ["config", "user.email", "grace@example.com"]);
  write(project, "g.txt", "g\n");
  await run(["add", "g.txt"]);
  await run(["commit", "-m", "by config"]);
  same("identity config", native(project, ["log", "-1", "--format=%an <%ae>"]), "Grace <grace@example.com>\n");
  native(project, ["config", "--unset", "user.name"]);
  native(project, ["config", "--unset", "user.email"]);
  write(project, "h.txt", "h\n");
  await run(["add", "h.txt"], {});
  await run(["commit", "-m", "default id"], {});
  same("identity default", native(project, ["log", "-1", "--format=%an <%ae>"]), "Playground <playground@runbun.dev>\n");

  // rm keeps a file with edits git doesn't have (like git), unless -f
  write(project, "h.txt", "h edited\n");
  r = await run(["rm", "h.txt"]);
  check("rm refuses edited", r.code === 1 && r.err.includes("local modifications") && readFileSync(join(project, "h.txt"), "utf8") === "h edited\n", JSON.stringify(r));
  r = await run(["rm", "-f", "h.txt"]);
  check("rm -f", r.code === 0 && !native(project, ["ls-files"]).includes("h.txt"), JSON.stringify(r));
  await run(["commit", "-m", "drop h"]);
  r = await run(["rm", "g.txt"]);
  check("rm clean", r.code === 0 && native(project, ["status", "--porcelain"]).split("\n").includes("D  g.txt") && !existsSync(join(project, "g.txt")), JSON.stringify(r));
  fsck(project);

  // ---- porcelain, log --format, show rev:path, branch, rev-parse ------------------------------------------------------
  const p2 = join(tmp, "p2");
  mkdirSync(p2);
  const g2 = (args: string[], env = ident) => git(p2, args, env);
  await g2(["init"]);
  r = await g2(["status", "-sb"]);
  same("status -sb unborn", r.out, native(p2, ["status", "-sb"]));
  same("status --porcelain -b -z unborn", (await g2(["status", "--porcelain", "-b", "-z"])).out, native(p2, ["status", "--porcelain", "-b", "-z"]));
  r = await g2(["rev-parse", "--verify", "-q", "HEAD"]);
  check("rev-parse --verify -q unborn", r.code === 1 && r.out === "" && r.err === "", JSON.stringify(r));
  r = await g2(["branch", "--show-current"]);
  same("branch --show-current unborn", r.out, "main\n");
  write(p2, "a.txt", "one\n");
  write(p2, "b.txt", "bee\n");
  write(p2, "c.txt", "cee\n");
  write(p2, "dir/x.txt", "x1\n");
  await g2(["add", "."]);
  await g2(["commit", "-m", "c1 subject", "-m", "c1 body\nsecond line"]);
  write(p2, "a.txt", "two\n");
  await g2(["commit", "-am", "c2"]);
  write(p2, "dir/y.txt", "y\n");
  await g2(["add", "dir/y.txt"]);
  await g2(["commit", "-m", "c3 touches dir"]);
  fsck(p2);

  const fmts = ["%H", "%h %s", "%an <%ae> %at", "%ad", "%P|%p", "[%s]%n[%b]", "%x00%x1f%%", "%B", "%T %t", "%cn %ce %ct %cd"];
  for (const f of fmts) same(`log --format=${f}`, (await g2(["log", `--format=${f}`])).out, native(p2, ["log", `--format=${f}`]));
  same("log --pretty=format: (separator)", (await g2(["log", "--pretty=format:%h %s"])).out, native(p2, ["log", "--pretty=format:%h %s"]));
  same("log --pretty=tformat:", (await g2(["log", "--pretty=tformat:%h"])).out, native(p2, ["log", "--pretty=tformat:%h"]));
  same("log -n 2 --format", (await g2(["log", "-n", "2", "--format=%s"])).out, native(p2, ["log", "-n", "2", "--format=%s"]));
  same("log -1 --format", (await g2(["log", "-1", "--format=%s"])).out, native(p2, ["log", "-1", "--format=%s"]));
  same("log --max-count=2", (await g2(["log", "--max-count=2", "--format=%s"])).out, native(p2, ["log", "--max-count=2", "--format=%s"]));
  same("log --skip=1", (await g2(["log", "--skip=1", "--format=%s"])).out, native(p2, ["log", "--skip=1", "--format=%s"]));
  same("log --skip=1 -n1", (await g2(["log", "--skip=1", "-n1", "--format=%s"])).out, native(p2, ["log", "--skip=1", "-n1", "--format=%s"]));
  same("log <rev>", (await g2(["log", "HEAD~1", "--format=%s"])).out, native(p2, ["log", "HEAD~1", "--format=%s"]));
  same("log -- path", (await g2(["log", "--format=%s", "--", "a.txt"])).out, native(p2, ["log", "--format=%s", "--", "a.txt"]));
  same("log -- dir", (await g2(["log", "--format=%s", "--", "dir"])).out, native(p2, ["log", "--format=%s", "--", "dir"]));
  same("log rev -- path", (await g2(["log", "HEAD~1", "--format=%s", "--", "a.txt", "c.txt"])).out, native(p2, ["log", "HEAD~1", "--format=%s", "--", "a.txt", "c.txt"]));
  same("log -- missing", (await g2(["log", "--format=%s", "--", "nope"])).out, "");
  r = await g2(["log", "--format=%ar"]);
  check("log %ar", /^(\d+ seconds? ago\n){3}$/.test(r.out), r.out);
  r = await g2(["log", "nope"]);
  check("log bad rev", r.code === 128 && r.err.startsWith("fatal: ambiguous argument 'nope'"), JSON.stringify(r));

  // show rev:path
  for (const spec of ["HEAD:a.txt", "HEAD~1:a.txt", "HEAD~2:a.txt", "main:dir/x.txt", "HEAD^:dir", `${native(p2, ["rev-parse", "--short", "HEAD"]).trim()}:c.txt`, ":a.txt", ":dir/x.txt", "HEAD:dir"]) {
    same(`show ${spec}`, (await g2(["show", spec])).out, native(p2, ["show", spec]));
  }
  r = await g2(["show", "HEAD:nope.txt"]);
  check("show missing path", r.code === 128 && r.err === "fatal: path 'nope.txt' does not exist in 'HEAD'\n" && r.out === "", JSON.stringify(r));
  r = await g2(["show", ":nope.txt"]);
  check("show missing index path", r.code === 128 && r.err.startsWith("fatal: path 'nope.txt' does not exist"), JSON.stringify(r));
  r = await g2(["show", "HEAD~9:a.txt"]);
  check("show bad rev", r.code === 128, JSON.stringify(r));

  // branch, rev-parse
  await g2(["branch", "merged"]);
  await g2(["branch", "old", "HEAD~1"]);
  same("branch --show-current", (await g2(["branch", "--show-current"])).out, native(p2, ["branch", "--show-current"]));
  same("branch --format", (await g2(["branch", "--format=%(refname:short)"])).out, native(p2, ["branch", "--format=%(refname:short)"]));
  same("branch --format objectname", (await g2(["branch", "--format=%(refname) %(objectname:short)"])).out, native(p2, ["branch", "--format=%(refname) %(objectname:short)"]));
  same("branch list", (await g2(["branch"])).out, native(p2, ["branch", "--no-color"]));
  same("rev-parse --verify", (await g2(["rev-parse", "--verify", "HEAD~1"])).out, native(p2, ["rev-parse", "--verify", "HEAD~1"]));
  same("rev-parse --abbrev-ref", (await g2(["rev-parse", "--abbrev-ref", "HEAD"])).out, "main\n");
  r = await g2(["rev-parse", "--verify", "-q", "nope"]);
  check("rev-parse --verify -q missing", r.code === 1 && r.out === "" && r.err === "", JSON.stringify(r));
  r = await g2(["rev-parse", "--verify", "nope"]);
  check("rev-parse --verify missing", r.code === 128 && r.err.startsWith("fatal: Needed a single revision"), JSON.stringify(r));
  r = await g2(["branch", "-d", "main"]);
  check("branch -d current", r.code === 1 && r.err.includes("cannot delete branch 'main'"), JSON.stringify(r));
  r = await g2(["branch", "-d", "merged"]);
  check("branch -d merged", r.code === 0 && /^Deleted branch merged \(was [0-9a-f]{7}\)\.\n$/.test(r.out), JSON.stringify(r));
  r = await g2(["branch", "-d", "nope"]);
  check("branch -d missing", r.code === 1 && r.err.includes("branch 'nope' not found"), JSON.stringify(r));
  await g2(["switch", "-c", "side"]);
  write(p2, "side.txt", "side\n");
  await g2(["add", "side.txt"]);
  await g2(["commit", "-m", "side work"]);
  await g2(["switch", "main"]);
  r = await g2(["branch", "-d", "side"]);
  check("branch -d unmerged", r.code === 1 && r.err.includes("not fully merged") && native(p2, ["branch", "--format=%(refname:short)"]).includes("side"), JSON.stringify(r));
  r = await g2(["branch", "-D", "side"]);
  check("branch -D", r.code === 0 && !native(p2, ["branch", "--format=%(refname:short)"]).includes("side"), JSON.stringify(r));
  r = await g2(["branch", "-m", "old", "older"]);
  same("branch -m", native(p2, ["branch", "--format=%(refname:short)"]), "main\nolder\n");
  await g2(["branch", "-m", "trunk"]);
  same("branch -m current", native(p2, ["branch", "--show-current"]), "trunk\n");
  await g2(["branch", "-m", "main"]);
  fsck(p2);

  // --all: both branches (compared as sets: commits within one second tie in order)
  await g2(["switch", "-c", "other"]);
  write(p2, "o.txt", "o\n");
  await g2(["add", "o.txt"]);
  await g2(["commit", "-m", "on other"]);
  await g2(["switch", "main"]);
  const lines = (s: string) => s.split("\n").sort().join("\n");
  same("log --all", lines((await g2(["log", "--all", "--format=%s"])).out), lines(native(p2, ["log", "--all", "--format=%s"])));

  // ---- twins: the same command on two copies of a project, ours vs native git ---------------------------------------
  const ids = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" };
  const natEnv = { ...process.env, ...ids, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", LC_ALL: "C", GIT_PAGER: "cat" };
  const A = join(tmp, "twin-a");
  const B = join(tmp, "twin-b");
  const state = (d: string, head = true) => [native(d, ["status", "--porcelain", "-b", "-uall"]), native(d, ["ls-files", "-s"]), head ? native(d, ["rev-parse", "HEAD"]) : native(d, ["log", "--format=%an|%at|%P|%B"]), files(d).join("\n")].join("\n--\n");
  async function twin(name: string, src: string, args: string[], opts: { setup?: (d: string) => void; nativeArgs?: string[]; out?: boolean; err?: boolean; code?: number } = {}) {
    for (const d of [A, B]) {
      rmSync(d, { recursive: true, force: true });
      cpSync(src, d, { recursive: true });
      opts.setup?.(d);
    }
    const ours = await git(A, args, ident);
    const nat = spawnSync("git", ["-C", B, ...(opts.nativeArgs ?? args)], { encoding: "utf8", env: natEnv });
    check(`${name}: exit`, ours.code === (opts.code ?? nat.status), `ours ${ours.code} native ${nat.status}\n${ours.err}\n${nat.stderr}`);
    same(`${name}: state`, state(A, !args.includes("--amend")), state(B, !args.includes("--amend")));
    if (opts.out) same(`${name}: stdout`, ours.out, nat.stdout);
    if (opts.err) same(`${name}: stderr`, ours.err, nat.stderr);
    try {
      native(A, ["fsck", "--full", "--strict"]);
    } catch (e) {
      check(`${name}: fsck`, false, String(e));
    }
    return ours;
  }
  const nat = (d: string, ...args: string[]) => {
    const x = spawnSync("git", ["-C", d, ...args], { encoding: "utf8", env: natEnv });
    if (x.status !== 0) throw new Error(`native ${args.join(" ")}: ${x.stderr}`);
  };

  // porcelain: staged, unstaged, both, deleted, untracked (a space, a quote, non-ASCII, a dir)
  rmSync(join(p2, "o.txt"), { force: true });
  write(p2, "s.txt", "staged new\n");
  write(p2, "c.txt", "cee staged\n");
  write(p2, "a.txt", "two staged\n");
  await g2(["add", "s.txt", "c.txt", "a.txt"]);
  write(p2, "a.txt", "two staged and edited\n");
  rmSync(join(p2, "b.txt"));
  await g2(["rm", "dir/y.txt"]);
  write(p2, "sp ace.txt", "1\n");
  write(p2, 'qu"ote.txt', "2\n");
  write(p2, "é.txt", "3\n");
  write(p2, "newdir/f1.txt", "4\n");
  write(p2, "newdir/sub/f2.txt", "5\n");
  write(p2, "dir/z.txt", "6\n");
  for (const a of [["--porcelain"], ["-s"], ["-sb"], ["--porcelain", "-b"], ["-z"], ["--porcelain", "-z", "-b"], ["--porcelain", "-uall"], ["-s", "--untracked-files=all"], ["--porcelain", "-uno"], ["--short", "--branch", "-uall"], ["--porcelain=v1", "-z"]]) {
    same(`status ${a.join(" ")}`, (await g2(["status", ...a])).out, native(p2, ["status", ...a]));
  }
  r = await g2(["status", "--porcelain", "-z"]);
  check("status -z raw", r.out.includes("?? sp ace.txt\0") && r.out.includes('?? qu"ote.txt\0') && r.out.includes("?? é.txt\0") && !r.out.includes("\n"), JSON.stringify(r.out));
  r = await g2(["status", "-s"]);
  check("status -s quoting", r.out.includes('?? "sp ace.txt"\n') && r.out.includes('?? "qu\\"ote.txt"\n') && r.out.includes('?? "\\303\\251.txt"\n'), r.out);
  same("porcelain ignores color", (await g2(["status", "--porcelain"], { ...ident, GIT_COLOR: "1" })).out, native(p2, ["status", "--porcelain"]));

  // reset, restore, clean on this dirty project
  for (const mode of ["--soft", "--mixed", "--hard"]) {
    for (const to of ["HEAD", "HEAD~1", "HEAD~2"]) {
      await twin(`reset ${mode} ${to}`, p2, ["reset", mode, to], { out: mode === "--hard" });
    }
  }
  await twin("reset (default)", p2, ["reset"]);
  await twin("reset HEAD~1", p2, ["reset", "HEAD~1"]);
  await twin("reset -- path", p2, ["reset", "--", "s.txt"]);
  await twin("reset HEAD~1 -- path", p2, ["reset", "HEAD~1", "--", "a.txt"]);
  await twin("restore worktree", p2, ["restore", "a.txt", "c.txt"]);
  await twin("restore .", p2, ["restore", "."]);
  await twin("restore --staged --worktree", p2, ["restore", "--staged", "--worktree", "a.txt", "s.txt"]);
  await twin("restore --source", p2, ["restore", "--source=HEAD~1", "a.txt"]);
  await twin("restore -s --staged --worktree", p2, ["restore", "-s", "HEAD~2", "--staged", "--worktree", "dir"]);
  await twin("restore missing", p2, ["restore", "nope.txt"], { err: true });
  await twin("checkout -- path", p2, ["checkout", "--", "a.txt", "b.txt"]);
  await twin("checkout rev -- path", p2, ["checkout", "HEAD~1", "--", "a.txt", "dir"]);
  await twin("clean -n -d", p2, ["clean", "-n", "-d"], { out: true });
  await twin("clean -n", p2, ["clean", "-n"], { out: true });
  await twin("clean -fd", p2, ["clean", "-fd"], { out: true });
  await twin("clean refuses", p2, ["clean"], { code: 128 });
  r = await g2(["clean", "-n", "-d", "newdir"]);
  check("clean -n -d path", r.out === "Would remove newdir/\n", r.out);

  // commit --amend
  await g2(["reset", "--hard"]);
  await twin("amend -m", p2, ["commit", "--amend", "-m", "rewritten"]);
  await twin("amend --no-edit", p2, ["commit", "--amend", "--no-edit"], { setup: (d) => { write(d, "late.txt", "late\n"); nat(d, "add", "late.txt"); } });
  write(p2, "q.txt", "q\n");
  const before = native(p2, ["log", "--format=%an|%at|%P|%s"]);
  await g2(["add", "q.txt"]);
  r = await g2(["commit", "--amend", "-m", "amended with q"]);
  const after = native(p2, ["log", "--format=%an|%at|%P|%s"]);
  const [b0, a0] = [before.split("\n"), after.split("\n")];
  check("amend keeps author, date, parents", r.code === 0 && b0.length === a0.length && b0[0].split("|").slice(0, 3).join("|") === a0[0].split("|").slice(0, 3).join("|") && b0.slice(1).join() === a0.slice(1).join(), `${before}\n${after}\n${r.err}`);
  same("amend adds the staged file", native(p2, ["show", "--name-only", "--format=%s", "HEAD"]), "amended with q\n\ndir/y.txt\nq.txt\n");
  r = await g2(["commit", "--amend"]);
  check("amend keeps message", native(p2, ["log", "-1", "--format=%s"]) === "amended with q\n", JSON.stringify(r));
  const empty = join(tmp, "empty");
  mkdirSync(empty);
  await git(empty, ["init"], ident);
  r = await git(empty, ["commit", "--amend", "-m", "x"], ident);
  check("amend nothing", r.code === 128 && r.err === "fatal: You have nothing to amend.\n", JSON.stringify(r));
  fsck(p2);

  // ---- switch / checkout --------------------------------------------------------------------------------------------
  const p3 = join(tmp, "p3");
  mkdirSync(p3);
  const g3 = (args: string[]) => git(p3, args, ident);
  await g3(["init"]);
  write(p3, "a.txt", "a\n");
  write(p3, "b.txt", "b\n");
  write(p3, "c.txt", "c\n");
  write(p3, "dir/x.txt", "x\n");
  await g3(["add", "."]);
  await g3(["commit", "-m", "m1"]);
  await g3(["switch", "-c", "feat"]);
  write(p3, "a.txt", "a on feat\n");
  rmSync(join(p3, "b.txt"));
  write(p3, "new.txt", "new\n");
  write(p3, "deep/er/f.txt", "f\n");
  write(p3, "dir/x.txt", "x on feat\n");
  await g3(["add", "-A"]);
  await g3(["commit", "-m", "f1"]);
  const p3f = join(tmp, "p3f");
  cpSync(p3, p3f, { recursive: true });
  await g3(["switch", "main"]);
  check("switch back restores", files(p3).join() === ["a.txt=a\n", "b.txt=b\n", "c.txt=c\n", "dir/x.txt=x\n"].join() && native(p3, ["status", "--porcelain"]) === "", files(p3).join());
  check("switch pruned empty dirs", !existsSync(join(p3, "deep")));
  same("switch HEAD", native(p3, ["branch", "--show-current"]), "main\n");

  await twin("switch feat", p3, ["switch", "feat"]);
  await twin("checkout feat", p3, ["checkout", "feat"]);
  await twin("switch carries dirty file", p3, ["switch", "feat"], { setup: (d) => write(d, "c.txt", "c dirty\n") });
  await twin("switch carries staged file", p3, ["switch", "feat"], { setup: (d) => { write(d, "c.txt", "c staged\n"); nat(d, "add", "c.txt"); } });
  await twin("switch carries untracked", p3, ["switch", "feat"], { setup: (d) => write(d, "u.txt", "u\n") });
  await twin("switch untracked dir beside", p3, ["switch", "feat"], { setup: (d) => write(d, "deep/other.txt", "o\n") });
  const conflict = await twin("switch refuses dirty", p3, ["switch", "feat"], { setup: (d) => write(d, "a.txt", "a dirty\n"), err: true });
  check("switch refusal message", conflict.code === 1 && conflict.err === "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n", JSON.stringify(conflict));
  check("refusal leaves the file", readFileSync(join(A, "a.txt"), "utf8") === "a dirty\n");
  await twin("checkout refuses dirty", p3, ["checkout", "feat"], { setup: (d) => write(d, "dir/x.txt", "x dirty\n") });
  await twin("switch refuses staged", p3, ["switch", "feat"], { setup: (d) => { write(d, "a.txt", "a staged\n"); nat(d, "add", "a.txt"); } });
  await twin("switch refuses deleted-modified", p3, ["switch", "feat"], { setup: (d) => { write(d, "a.txt", "a staged\n"); nat(d, "add", "a.txt"); rmSync(join(d, "a.txt")); } });
  await twin("switch allows deleted", p3, ["switch", "feat"], { setup: (d) => rmSync(join(d, "b.txt")) });
  const untr = await twin("switch refuses untracked", p3, ["switch", "feat"], { setup: (d) => write(d, "new.txt", "mine\n"), err: true });
  check("untracked refusal message", untr.err.startsWith("error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\n") && readFileSync(join(A, "new.txt"), "utf8") === "mine\n", untr.err);
  await twin("switch refuses untracked in dir", p3, ["switch", "feat"], { setup: (d) => write(d, "deep/er/f.txt", "mine\n") });
  await twin("switch refuses file where dir goes", p3, ["switch", "feat"], { setup: (d) => write(d, "deep", "a file\n") });
  await twin("switch -c", p3, ["switch", "-c", "topic"]);
  await twin("switch -c start", p3, ["switch", "-c", "topic", "feat"]);
  await twin("switch -c start dirty conflict", p3, ["switch", "-c", "topic", "feat"], { setup: (d) => write(d, "a.txt", "dirty\n") });
  await twin("checkout -b", p3, ["checkout", "-b", "topic"]);
  await twin("checkout -b start", p3, ["checkout", "-b", "topic", "feat"]);
  await twin("switch -c exists", p3, ["switch", "-c", "feat"]);
  await twin("switch same branch", p3, ["switch", "main"]);
  await twin("switch missing", p3, ["switch", "nope"]);
  await twin("checkout detach hash", p3, ["checkout", native(p3f, ["rev-parse", "HEAD"]).trim()]);
  await twin("switch --detach", p3, ["switch", "--detach", "feat"]);
  await twin("checkout -f", p3, ["checkout", "-f", "feat"], { setup: (d) => { write(d, "a.txt", "dirty\n"); write(d, "c.txt", "dirty c\n"); } });
  await twin("switch -f", p3, ["switch", "-f", "feat"], { setup: (d) => { write(d, "a.txt", "dirty\n"); nat(d, "add", "a.txt"); } });
  // from feat back to main
  await twin("feat -> main", p3f, ["switch", "main"]);
  await twin("feat -> main, deleted file edited", p3f, ["switch", "main"], { setup: (d) => write(d, "new.txt", "edited\n") });
  await twin("feat -> main, untracked b.txt", p3f, ["switch", "main"], { setup: (d) => write(d, "b.txt", "mine\n") });
  await twin("feat -> main, carry", p3f, ["switch", "main"], { setup: (d) => write(d, "c.txt", "carried\n") });
  await twin("feat -> main, dir has untracked", p3f, ["switch", "main"], { setup: (d) => write(d, "deep/er/keep.txt", "k\n") });
  await twin("feat: restore --source main", p3f, ["restore", "--source=main", "a.txt"]);
  await twin("feat: restore -s main -SW", p3f, ["restore", "-s", "main", "-S", "-W", "."]);
  await twin("feat: checkout main -- .", p3f, ["checkout", "main", "--", "."]);
  await twin("feat: checkout main -- b.txt", p3f, ["checkout", "main", "--", "b.txt"]);
  await twin("feat: reset --hard main", p3f, ["reset", "--hard", "main"], { out: true });
  await twin("feat: reset --soft HEAD~1", p3f, ["reset", "--soft", "HEAD~1"]);
  await twin("feat: reset --hard dirty", p3f, ["reset", "--hard", "HEAD~1"], { setup: (d) => { write(d, "a.txt", "d\n"); write(d, "u.txt", "u\n"); nat(d, "add", "u.txt"); } });
  await twin("feat: reset bad rev", p3f, ["reset", "--hard", "nope"]);

  // ---- config ---------------------------------------------------------------------------------------------------------
  const p4 = join(tmp, "p4");
  mkdirSync(p4);
  const g4 = (args: string[]) => git(p4, args, ident);
  await g4(["init"]);
  check("config get init", (await g4(["config", "core.fileMode"])).out === "false\n");
  await g4(["config", "user.name", "Grace Hopper"]);
  await g4(["config", "user.email", "grace@example.com"]);
  await g4(["config", "remote.origin.url", "https://example.com/r.git"]);
  await g4(["config", "Core.Editor", "vim"]);
  for (const k of ["user.name", "user.email", "remote.origin.url", "core.editor"]) same(`config set ${k}`, native(p4, ["config", "--get", k]), (await g4(["config", "--get", k])).out);
  same("config --list", (await g4(["config", "--list"])).out, native(p4, ["config", "--local", "--list"]));
  same("config -l --local", (await g4(["config", "--local", "-l"])).out, native(p4, ["config", "--local", "--list"]));
  r = await g4(["config", "user.name", "Ada Lovelace"]);
  same("config overwrite", native(p4, ["config", "--get", "user.name"]), "Ada Lovelace\n");
  r = await g4(["config", "nope.key"]);
  check("config unset key exits 1", r.code === 1 && r.out === "", JSON.stringify(r));
  r = await g4(["config", "--unset", "user.email"]);
  check("config --unset", r.code === 0 && nativeCode(p4, ["config", "--get", "user.email"]) === 1, JSON.stringify(r));
  r = await g4(["config", "--global", "user.name", "x"]);
  check("config --global refused", r.code === 128 && r.err === "fatal: only --local config in the playground\n", JSON.stringify(r));
  write(p4, "f.txt", "f\n");
  await g4(["add", "f.txt"]);
  await g4(["commit", "-m", "by config"], );
  same("commit identity from config", native(p4, ["log", "-1", "--format=%an"]), "Ada Lovelace\n");
  fsck(p4);

  r = await run(["help"]);
  check("help lists the new commands", ["switch", "checkout", "config", "clean"].every((c) => r.out.includes(` ${c} `)), r.out);

  // Reading an existing packed repo: a clone of this repo.
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const clone = join(tmp, "clone");
  execFileSync("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", repoRoot, clone]);
  const t = performance.now();
  const cl = await git(clone, ["log", "--oneline"]);
  const logMs = performance.now() - t;
  const n = native(clone, ["log", "--oneline"]).split("\n").length;
  check("clone log count", cl.out.split("\n").length === n && cl.code === 0, `ours ${cl.out.split("\n").length} native ${n}\n${cl.err}`);
  const t2 = performance.now();
  const cs = await git(clone, ["status", "-s"]);
  check("clone status clean", cs.out === "" && cs.code === 0 && native(clone, ["status", "--porcelain"]) === "", cs.out + cs.err);
  console.log(`clone: ${n - 1} commits in ${logMs.toFixed(0)} ms, status ${(performance.now() - t2).toFixed(0)} ms`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`${failures.length} of ${checks} checks failed:\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`git-wasm: ${checks} checks passed`);
