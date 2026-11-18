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

  // renames, as git pairs them: an exact one into another folder, one with edits (git's similarity), and a deletion
  // and an addition too different to pair
  write(project, "src/long.ts", Array.from({ length: 20 }, (_, i) => `export const value${i} = ${i * 7};\n`).join(""));
  await run(["add", "src/long.ts"]);
  await run(["commit", "-m", "files to rename"]);
  write(project, "lib/util.ts", readFileSync(join(project, "src/util.ts"), "utf8"));
  rmSync(join(project, "src/util.ts"));
  write(project, "src/longer.ts", readFileSync(join(project, "src/long.ts"), "utf8").replace("value3 = 21", "value3 = 22").replace("value9 =", "renamed9 ="));
  rmSync(join(project, "src/long.ts"));
  rmSync(join(project, "docs/a.md"));
  write(project, "docs/c.md", "nothing like a\n");
  await run(["add", "-A", "src", "lib", "docs"]);
  same("status -s renames", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  same("status -z renames", (await run(["status", "-z"])).out, native(project, ["status", "-z"]));
  same("status renames", (await run(["status"])).out, native(project, ["status"]));
  same("diff --cached renames", (await run(["diff", "--cached"])).out, native(project, ["diff", "--cached", "--no-color"]));
  write(project, "lib/util.ts", "export const a = 1;\nexport const b = 3;\n");
  same("status -s rename then edit", (await run(["status", "-s"])).out, native(project, ["status", "-s"]));
  await run(["add", "lib/util.ts"]);
  r = await run(["commit", "-m", "renames"]);
  same("commit summary renames", r.out.split("\n").slice(1).join("\n"), native(project, ["show", "--format=", "--shortstat", "--summary", "HEAD"]));
  same("show renames", (await run(["show"])).out, native(project, ["show", "--no-color"]));
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
  // HEAD: its id; for new commits (whose time and zone differ) their tree, parents, author and message
  const heads = { id: ["rev-parse", "HEAD"], log: ["log", "--format=%an|%at|%P|%B"], tree: ["log", "-1", "--format=%T|%P|%an|%ae|%B"] };
  const state = (d: string, head: keyof typeof heads = "id") => [native(d, ["status", "--porcelain", "-b", "-uall"]), native(d, ["ls-files", "-s"]), spawnSync("git", ["-C", d, ...heads[head]], { encoding: "utf8", env: natEnv }).stdout, files(d).join("\n")].join("\n--\n");
  type TwinOpts = { setup?: (d: string) => void; nativeArgs?: string[]; out?: boolean; err?: boolean; code?: number; head?: keyof typeof heads; extra?: (d: string) => string; markers?: boolean };
  // conflict markers' labels that can't match: an octopus's are git-merge-one-file's temp file names
  const unlabel = (d: string) => {
    for (const f of files(d)) {
      const p = join(d, f.slice(0, f.indexOf("=")));
      writeFileSync(p, readFileSync(p, "utf8").replace(/^(<{7}|>{7}) .*$/gm, "$1"));
    }
  };
  async function twin(name: string, src: string, args: string[], opts: TwinOpts = {}) {
    for (const d of [A, B]) {
      rmSync(d, { recursive: true, force: true });
      cpSync(src, d, { recursive: true });
      // the copy's files are newer than the index says: some native commands (reset --merge) won't refresh it
      spawnSync("git", ["-C", d, "update-index", "-q", "--refresh"], { env: natEnv });
      opts.setup?.(d);
    }
    const ours = await git(A, args, ident);
    const nat = spawnSync("git", ["-C", B, ...(opts.nativeArgs ?? args)], { encoding: "utf8", env: natEnv });
    check(`${name}: exit`, ours.code === (opts.code ?? nat.status), `ours ${ours.code} native ${nat.status}\n${ours.err}\n${nat.stderr}`);
    if (opts.markers) for (const d of [A, B]) unlabel(d);
    const head = opts.head ?? (args.includes("--amend") ? "log" : "id");
    same(`${name}: state`, state(A, head), state(B, head));
    if (opts.extra) same(`${name}: extra`, opts.extra(A), opts.extra(B));
    if (opts.out) same(`${name}: stdout`, ours.out, nat.stdout);
    if (opts.err) same(`${name}: stderr`, ours.err, nat.stderr);
    try {
      if (spawnSync("git", ["-C", A, "rev-parse", "-q", "--verify", "HEAD"]).status === 0) native(A, ["fsck", "--full", "--strict"]);
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

  // ---- merge ----------------------------------------------------------------------------------------------------------
  const natIn = (d: string, ...args: string[]) => spawnSync("git", ["-C", d, ...args], { encoding: "utf8", env: natEnv });
  const mergeState = (d: string) => ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "SQUASH_MSG"].map((f) => `${f}: ${existsSync(join(d, ".git", f)) ? readFileSync(join(d, ".git", f), "utf8") : "-"}`).join("\n");
  const longStatus = (d: string) => native(d, ["status"]);
  const p5 = join(tmp, "p5");
  mkdirSync(p5);
  nat(p5, "init", "-q", "-b", "main");
  nat(p5, "config", "core.fileMode", "false");
  write(p5, "a.txt", "a\nb\nc\n");
  write(p5, "b.txt", "b\n");
  write(p5, "k.txt", "keep\n");
  write(p5, "long.txt", Array.from({ length: 120 }, (_, i) => `line ${i}\n`).join(""));
  nat(p5, "add", ".");
  nat(p5, "commit", "-qm", "m1");
  nat(p5, "switch", "-qc", "feat");
  write(p5, "a.txt", "a\nB\nc\n");
  write(p5, "n.txt", "new\n");
  write(p5, "long.txt", Array.from({ length: 120 }, (_, i) => `line ${i}${i % 2 ? " changed" : ""}\n`).join(""));
  nat(p5, "rm", "-q", "b.txt");
  nat(p5, "add", "-A");
  nat(p5, "commit", "-qm", "f1");
  nat(p5, "tag", "light");
  nat(p5, "tag", "-a", "ann", "-m", "annotated tag", "-m", "with a body");
  nat(p5, "switch", "-q", "main");
  const ms = { head: "tree" as const, out: true, err: true, extra: mergeState };
  await twin("merge ff", p5, ["merge", "feat"], ms);
  await twin("merge up to date", p5, ["merge", "main"], ms);
  await twin("merge ff dirty elsewhere", p5, ["merge", "feat"], { ...ms, setup: (d) => write(d, "k.txt", "dirty\n") });
  await twin("merge ff refuses dirty", p5, ["merge", "feat"], { ...ms, setup: (d) => write(d, "a.txt", "dirty\n") });
  await twin("merge ff refuses untracked", p5, ["merge", "feat"], { ...ms, setup: (d) => write(d, "n.txt", "mine\n") });
  await twin("merge --no-ff", p5, ["merge", "--no-ff", "feat"], ms);
  await twin("merge --no-ff -m", p5, ["merge", "--no-ff", "-m", "custom message", "feat"], ms);
  await twin("merge --no-ff tag", p5, ["merge", "--no-ff", "light"], ms);
  await twin("merge --no-ff annotated tag", p5, ["merge", "--no-ff", "ann"], ms);
  await twin("merge -q", p5, ["merge", "-q", "feat"], ms);
  await twin("merge nope", p5, ["merge", "nope"], ms);
  await twin("merge no upstream", p5, ["merge"], ms);
  // diverged: a true merge
  const p5d = join(tmp, "p5d");
  cpSync(p5, p5d, { recursive: true });
  write(p5d, "k.txt", "keep\nmore\n");
  nat(p5d, "commit", "-qam", "m2");
  await twin("merge true", p5d, ["merge", "feat"], ms);
  await twin("merge true hash", p5d, ["merge", native(p5d, ["rev-parse", "feat"]).trim()], ms);
  await twin("merge true dirty elsewhere", p5d, ["merge", "feat"], { ...ms, setup: (d) => write(d, "u.txt", "untracked\n") });
  await twin("merge true refuses dirty", p5d, ["merge", "feat"], { ...ms, setup: (d) => write(d, "a.txt", "dirty\n") });
  await twin("merge true refuses staged", p5d, ["merge", "feat"], { ...ms, setup: (d) => { write(d, "k.txt", "staged\n"); nat(d, "add", "k.txt"); } });
  await twin("merge true refuses untracked", p5d, ["merge", "feat"], { ...ms, setup: (d) => write(d, "n.txt", "mine\n") });
  await twin("merge --ff-only", p5d, ["merge", "--ff-only", "feat"], ms);
  await twin("merge into other branch", p5d, ["merge", "feat"], { ...ms, setup: (d) => nat(d, "switch", "-qc", "topic") });
  // conflicts: content, modify/delete, add/add
  const p5c = join(tmp, "p5c");
  cpSync(p5, p5c, { recursive: true });
  write(p5c, "a.txt", "a\nX\nc\n");
  write(p5c, "b.txt", "modified\n");
  write(p5c, "n.txt", "mine\n");
  nat(p5c, "add", "-A");
  nat(p5c, "commit", "-qm", "m3");
  await twin("merge conflict", p5c, ["merge", "feat"], { ...ms, extra: (d) => mergeState(d) + longStatus(d) });
  await twin("merge conflict --no-ff", p5c, ["merge", "--no-ff", "feat"], ms);
  // in the middle of the conflicted merge (made by native git)
  const p5m = join(tmp, "p5m");
  cpSync(p5c, p5m, { recursive: true });
  natIn(p5m, "merge", "feat");
  for (const a of [["status"], ["status", "-s"], ["status", "--porcelain", "-z"]]) await twin(`conflicted ${a.join(" ")}`, p5m, a, { out: true });
  await twin("conflicted commit refused", p5m, ["commit", "-m", "x"], ms);
  await twin("conflicted merge refused", p5m, ["merge", "feat"], ms);
  await twin("conflicted switch refused", p5m, ["switch", "feat"], { err: true });
  await twin("conflicted checkout refused", p5m, ["checkout", "feat"], { err: true, out: true });
  await twin("merge --abort", p5m, ["merge", "--abort"], ms);
  await twin("merge --abort keeps local changes", p5m, ["merge", "--abort"], { ...ms, setup: (d) => write(d, "k.txt", "local\n") });
  await twin("merge --abort without merge", p5, ["merge", "--abort"], ms);
  await twin("reset --hard ends the merge", p5m, ["reset", "--hard"], { ...ms, out: false });
  await twin("add resolves", p5m, ["add", "a.txt", "n.txt"], { ...ms, extra: (d) => mergeState(d) + longStatus(d) });
  await twin("rm resolves", p5m, ["rm", "-q", "b.txt"], { ...ms, extra: (d) => mergeState(d) + longStatus(d) });
  const resolved = (d: string) => { write(d, "a.txt", "a\nXB\nc\n"); nat(d, "add", "-A"); };
  await twin("all resolved status", p5m, ["status"], { setup: resolved, out: true });
  await twin("merge commit", p5m, ["commit"], { setup: resolved, ...ms, nativeArgs: ["commit", "--no-edit"], out: false });
  await twin("merge commit -m", p5m, ["commit", "-m", "resolved"], { setup: resolved, ...ms, out: false });
  await twin("merge --continue", p5m, ["merge", "--continue"], { setup: resolved, ...ms, nativeArgs: ["commit", "--no-edit"], out: false });
  await twin("commit -a resolves", p5m, ["commit", "-a", "-m", "all"], { ...ms, out: false });
  rmSync(A, { recursive: true, force: true });
  cpSync(p5m, A, { recursive: true });
  resolved(A);
  r = await git(A, ["commit"], ident);
  same("merge commit output", r.out.replace(/ [0-9a-f]{7}\]/, " X]"), "[main X] Merge branch 'feat'\n");
  same("merge commit message", native(A, ["log", "-1", "--format=%B"]), "Merge branch 'feat'\n\n# Conflicts:\n#\ta.txt\n#\tb.txt\n#\tn.txt\n\n");
  check("merge commit parents", native(A, ["log", "-1", "--format=%P"]).trim().split(" ").length === 2);
  check("merge state gone", !existsSync(join(A, ".git/MERGE_HEAD")) && !existsSync(join(A, ".git/MERGE_MSG")));

  // octopus merges, --squash, --no-commit, merging into an unborn branch
  const p8 = join(tmp, "p8");
  mkdirSync(p8);
  nat(p8, "init", "-q", "-b", "main");
  nat(p8, "config", "core.fileMode", "false");
  write(p8, "a.txt", "a\nb\nc\n");
  write(p8, "k.txt", "k\n");
  nat(p8, "add", ".");
  nat(p8, "commit", "-qm", "m1");
  nat(p8, "switch", "-qc", "b1");
  write(p8, "one.txt", "one\n");
  nat(p8, "add", ".");
  nat(p8, "commit", "-qm", "b1");
  nat(p8, "tag", "-a", "t1", "-m", "tag one", "b1");
  nat(p8, "switch", "-qc", "b2", "main");
  write(p8, "two.txt", "two\n");
  write(p8, "a.txt", "a\nb\nC\n");
  nat(p8, "add", ".");
  nat(p8, "commit", "-qm", "b2");
  nat(p8, "switch", "-qc", "b3", "main");
  write(p8, "a.txt", "A\nb\nc\n");
  nat(p8, "commit", "-qam", "b3");
  nat(p8, "switch", "-qc", "b4", "main");
  write(p8, "a.txt", "a\nb\nZ\n");
  nat(p8, "commit", "-qam", "b4\n\nwith a body");
  nat(p8, "switch", "-q", "main");
  write(p8, "k.txt", "k2\n");
  nat(p8, "commit", "-qam", "m2");
  const behind = (d: string) => nat(d, "switch", "-qc", "base", "main~1");
  await twin("merge octopus", p8, ["merge", "b1", "b2"], ms);
  await twin("merge octopus content merge", p8, ["merge", "b1", "b2", "b3"], ms);
  await twin("merge octopus -m", p8, ["merge", "-m", "many", "b1", "b2"], ms);
  await twin("merge octopus branch and tag", p8, ["merge", "t1", "b2", "b3"], ms);
  await twin("merge octopus -q", p8, ["merge", "-q", "b1", "b2"], ms);
  await twin("merge octopus fast-forwards first", p8, ["merge", "b1", "b2"], { ...ms, setup: behind });
  await twin("merge octopus --no-ff keeps HEAD", p8, ["merge", "--no-ff", "b1", "b2"], { ...ms, setup: behind });
  await twin("merge octopus drops merged heads", p8, ["merge", "main~1", "b1", "b2"], ms);
  await twin("merge octopus all merged", p8, ["merge", "main~1", "main"], ms);
  await twin("merge octopus conflict", p8, ["merge", "b1", "b2", "b4"], { ...ms, markers: true });
  await twin("merge octopus conflict before the last", p8, ["merge", "b2", "b4", "b1"], ms);
  await twin("merge octopus refuses staged", p8, ["merge", "b1", "b2"], { ...ms, setup: (d) => { write(d, "a.txt", "x\n"); nat(d, "add", "a.txt"); } });
  await twin("merge octopus refuses dirty", p8, ["merge", "b1", "b2"], { ...ms, setup: (d) => write(d, "a.txt", "x\n") });
  await twin("merge octopus refuses untracked", p8, ["merge", "b1", "b2"], { ...ms, setup: (d) => write(d, "one.txt", "mine\n") });
  await twin("merge octopus dirty elsewhere", p8, ["merge", "b1", "b2"], { ...ms, setup: (d) => write(d, "k.txt", "x\n") });
  await twin("merge octopus --ff-only", p8, ["merge", "--ff-only", "b1", "b2"], ms);
  await twin("merge octopus --no-commit", p8, ["merge", "--no-commit", "b1", "b2"], ms);
  await twin("merge octopus detached", p8, ["merge", "b1", "b2"], { ...ms, setup: (d) => nat(d, "switch", "-q", "--detach") });
  await twin("merge octopus nope", p8, ["merge", "b1", "nope"], ms);
  await twin("commit after octopus --no-commit", p8, ["commit"], { ...ms, setup: (d) => nat(d, "merge", "-q", "--no-commit", "b1", "b2"), nativeArgs: ["commit", "--no-edit"], out: false });
  await twin("merge --no-commit", p8, ["merge", "--no-commit", "b1"], ms);
  await twin("merge --no-commit fast-forward", p8, ["merge", "--no-commit", "b1"], { ...ms, setup: behind });
  await twin("merge --no-commit --no-ff", p8, ["merge", "--no-commit", "--no-ff", "b1"], { ...ms, setup: behind });
  await twin("merge --no-commit conflict", p8, ["merge", "--no-commit", "b4"], { ...ms, setup: (d) => nat(d, "switch", "-q", "b2") });
  await twin("commit after --no-commit", p8, ["commit"], { ...ms, setup: (d) => nat(d, "merge", "-q", "--no-commit", "b1"), nativeArgs: ["commit", "--no-edit"], out: false });
  await twin("merge --squash", p8, ["merge", "--squash", "b1"], ms);
  await twin("merge --squash fast-forward", p8, ["merge", "--squash", "b1"], { ...ms, setup: behind });
  await twin("merge --squash of a history", p8, ["merge", "--squash", "main"], { ...ms, setup: (d) => { nat(d, "switch", "-qc", "base", "b1"); } });
  await twin("merge --squash conflict", p8, ["merge", "--squash", "b4"], { ...ms, setup: (d) => nat(d, "switch", "-q", "b2") });
  await twin("merge --squash --no-ff", p8, ["merge", "--squash", "--no-ff", "b1"], ms);
  await twin("merge --squash up to date", p8, ["merge", "--squash", "main~1"], ms);
  await twin("merge --squash octopus", p8, ["merge", "--squash", "b1", "b2"], ms);
  await twin("commit after --squash", p8, ["commit"], { ...ms, setup: (d) => nat(d, "merge", "-q", "--squash", "b4"), nativeArgs: ["commit", "--no-edit"], out: false });
  await twin("commit -m after --squash", p8, ["commit", "-m", "squashed"], { ...ms, setup: (d) => nat(d, "merge", "-q", "--squash", "b1"), out: false });
  const squashConflict = (d: string) => { nat(d, "switch", "-q", "b2"); natIn(d, "merge", "--squash", "b4"); write(d, "a.txt", "a\nb\nCZ\n"); nat(d, "add", "a.txt"); };
  await twin("commit after --squash conflict", p8, ["commit"], { ...ms, setup: squashConflict, nativeArgs: ["commit", "--no-edit"], out: false });
  const orphan = (d: string) => nat(d, "switch", "-q", "--orphan", "empty");
  await twin("merge into unborn", p8, ["merge", "b1"], { ...ms, setup: orphan });
  await twin("merge into unborn -q --no-commit", p8, ["merge", "-q", "--no-commit", "b1"], { ...ms, setup: orphan });
  await twin("merge into unborn keeps staged", p8, ["merge", "b1"], { ...ms, setup: (d) => { orphan(d); write(d, "s.txt", "s\n"); nat(d, "add", "s.txt"); } });
  await twin("merge into unborn refuses untracked", p8, ["merge", "b1"], { ...ms, setup: (d) => { orphan(d); write(d, "one.txt", "mine\n"); } });
  for (const a of [["b1", "b2"], ["--squash", "b1"], ["--no-ff", "b1"]]) await twin(`merge into unborn ${a.join(" ")}`, p8, ["merge", ...a], { ...ms, setup: orphan });
  await twin("merge detached", p8, ["merge", "--no-ff", "b1"], { ...ms, setup: (d) => nat(d, "switch", "-q", "--detach") });

  // ---- tag ------------------------------------------------------------------------------------------------------------
  // the tags as refs and objects (an annotated tag's id differs: its tagger's time)
  const tagState = (d: string) =>
    native(d, ["for-each-ref", "refs/tags", "--format=%(refname)|%(objecttype)|%(if:equals=tag)%(objecttype)%(then)%(*objecttype) %(*objectname) %(tag) %(taggername) %(taggeremail)%(else)%(objectname)%(end)|%(contents)"]);
  const p6 = join(tmp, "p6");
  cpSync(p5d, p6, { recursive: true });
  nat(p6, "tag", "-a", "empty", "-m", "");
  nat(p6, "tag", "a-very-long-tag-name");
  const ts = { out: true, err: true, extra: tagState };
  for (const a of [[], ["-l"], ["--list"], ["-l", "a*"], ["--list", "?nn", "l*"], ["-l", "[a-e]*"], ["-l", "[!a]*"], ["-n"], ["-n2"], ["-n3"], ["-l", "-n", "a*"], ["-n1", "ann"]]) {
    await twin(`tag ${a.join(" ")}`, p6, ["tag", ...a], ts);
  }
  await twin("tag lightweight", p6, ["tag", "v1"], ts);
  await twin("tag lightweight at rev", p6, ["tag", "v1", "HEAD~1"], ts);
  await twin("tag -a -m -m", p6, ["tag", "-a", "v2", "-m", "release two", "-m", "para two"], ts);
  await twin("tag -m", p6, ["tag", "-m", "only m", "v3", "feat"], ts);
  await twin("tag -a without message", p6, ["tag", "-a", "nomsg"], ts);
  await twin("tag exists", p6, ["tag", "light"], ts);
  await twin("tag -f moves", p6, ["tag", "-f", "light", "HEAD~1"], ts);
  await twin("tag -f same", p6, ["tag", "-f", "light", "feat"], ts);
  await twin("tag -d", p6, ["tag", "-d", "light", "ann"], ts);
  await twin("tag -d missing", p6, ["tag", "-d", "nope", "light"], ts);
  await twin("tag -d none", p6, ["tag", "-d"], ts);
  await twin("tag bad name", p6, ["tag", "bad..name"], ts);
  await twin("tag bad rev", p6, ["tag", "x", "nope"], ts);
  await twin("tag nested", p6, ["tag", "-a", "nested", "-m", "n", "ann"], ts);
  r = await git(empty, ["tag", "v0"], ident);
  check("tag unborn", r.code === 128 && r.err === "fatal: Failed to resolve 'HEAD' as a valid ref.\n", JSON.stringify(r));
  await twin("show annotated tag", p6, ["show", "ann"], { out: true });
  await twin("show lightweight tag", p6, ["show", "light"], { out: true });
  await twin("log tag", p6, ["log", "--oneline", "ann"], { out: true, nativeArgs: ["log", "--oneline", "--no-decorate", "ann"] });

  // ---- stash ----------------------------------------------------------------------------------------------------------
  // the list, and per entry its trees and messages as stored (ids differ: commit times)
  const stashState = (d: string) => {
    const listed = natIn(d, "stash", "list").stdout;
    let s = listed;
    const body = (rev: string) => { const c = natIn(d, "cat-file", "commit", rev); return c.status ? "-" : JSON.stringify(c.stdout.slice(c.stdout.indexOf("\n\n") + 2)); };
    const id = (rev: string) => natIn(d, "rev-parse", "-q", "--verify", rev).stdout.trim() || "-";
    for (let i = 0; i < listed.split("\n").filter(Boolean).length; i++) {
      const e = `stash@{${i}}`;
      s += [id(`${e}^{tree}`), id(`${e}^1`), id(`${e}^2^{tree}`), (id(`${e}^3`) === "-" ? "-" : id(`${e}^3^{tree}`)), id(`${e}^4`), id(`${e}^2^1`), id(`${e}^3^1`), body(e), body(`${e}^2`), body(`${e}^3`)].join("|") + "\n";
    }
    return s;
  };
  const p7 = join(tmp, "p7");
  cpSync(p5, p7, { recursive: true });
  const dirty = (d: string) => {
    write(d, "a.txt", "a\nb\nc\nA\n");
    write(d, "b.txt", "staged\n");
    write(d, "n2.txt", "new staged\n");
    nat(d, "add", "b.txt", "n2.txt");
    rmSync(join(d, "k.txt"));
    write(d, "u.txt", "untracked\n");
    write(d, "ud/deep.txt", "untracked deep\n");
  };
  const ss = { out: true, err: true, extra: stashState };
  await twin("stash nothing", p7, ["stash"], ss);
  await twin("stash list empty", p7, ["stash", "list"], ss);
  await twin("stash pop empty", p7, ["stash", "pop"], ss);
  await twin("stash show empty", p7, ["stash", "show"], ss);
  await twin("stash", p7, ["stash"], { ...ss, setup: dirty });
  // what we stashed, native git pops (and the other way round below)
  same("native pops our stash", (natIn(A, "stash", "pop"), state(A)), (natIn(B, "stash", "pop"), state(B)));
  await twin("stash push -m", p7, ["stash", "push", "-m", "my message"], { ...ss, setup: dirty });
  await twin("stash -m", p7, ["stash", "-m", "short form"], { ...ss, setup: dirty });
  await twin("stash save", p7, ["stash", "save", "saved", "words"], { ...ss, setup: dirty });
  await twin("stash -q", p7, ["stash", "-q"], { ...ss, setup: dirty });
  await twin("stash -u", p7, ["stash", "-u"], { ...ss, setup: dirty });
  same("native pops our -u stash", (natIn(A, "stash", "pop"), state(A)), (natIn(B, "stash", "pop"), state(B)));
  await twin("stash only untracked -u", p7, ["stash", "-u"], { ...ss, setup: (d) => write(d, "u.txt", "u\n") });
  await twin("stash only untracked", p7, ["stash"], { ...ss, setup: (d) => write(d, "u.txt", "u\n") });
  await twin("stash detached", p7, ["stash"], { ...ss, setup: (d) => { nat(d, "switch", "-q", "--detach"); dirty(d); } });
  r = await git(empty, ["stash"], ident);
  check("stash unborn", r.code === 1 && r.err === "You do not have the initial commit yet\n", JSON.stringify(r));
  // a stash list made by native git
  const p7s = join(tmp, "p7s");
  cpSync(p7, p7s, { recursive: true });
  dirty(p7s);
  nat(p7s, "stash", "-u");
  write(p7s, "a.txt", "a\nb\nc\nsecond\n");
  nat(p7s, "stash", "push", "-m", "second");
  write(p7s, "b.txt", "third\n");
  nat(p7s, "add", "b.txt");
  nat(p7s, "stash");
  for (const a of [["list"], ["show"], ["show", "1"], ["show", "stash@{2}"], ["show", "-p"], ["show", "-p", "stash@{2}"], ["show", "--stat", "-p", "1"]]) {
    await twin(`stash ${a.join(" ")}`, p7s, ["stash", ...a], ss);
  }
  await twin("stash apply", p7s, ["stash", "apply"], ss);
  await twin("stash apply 1", p7s, ["stash", "apply", "1"], ss);
  await twin("stash apply stash@{2} (untracked)", p7s, ["stash", "apply", "stash@{2}"], ss);
  await twin("stash apply --index", p7s, ["stash", "apply", "--index"], ss);
  await twin("stash apply --index stash@{2}", p7s, ["stash", "apply", "--index", "stash@{2}"], ss);
  await twin("stash apply -q", p7s, ["stash", "apply", "-q"], ss);
  await twin("stash apply with staged elsewhere", p7s, ["stash", "apply", "1"], { ...ss, setup: (d) => { write(d, "k.txt", "staged\n"); nat(d, "add", "k.txt"); } });
  await twin("stash apply refuses dirty", p7s, ["stash", "apply", "1"], { ...ss, setup: (d) => write(d, "a.txt", "dirty\n") });
  await twin("stash apply untracked taken", p7s, ["stash", "apply", "stash@{2}"], { ...ss, setup: (d) => write(d, "u.txt", "mine\n") });
  await twin("stash pop", p7s, ["stash", "pop"], ss);
  await twin("stash pop 1", p7s, ["stash", "pop", "1"], ss);
  await twin("stash pop conflict", p7s, ["stash", "pop", "1"], { ...ss, setup: (d) => { write(d, "a.txt", "a\nb\nc\nZ\n"); nat(d, "commit", "-qam", "conflicting"); }, head: "tree" });
  await twin("stash drop", p7s, ["stash", "drop"], ss);
  await twin("stash drop 1", p7s, ["stash", "drop", "1"], ss);
  await twin("stash drop stash@{2}", p7s, ["stash", "drop", "stash@{2}"], ss);
  await twin("stash drop -q", p7s, ["stash", "drop", "-q"], ss);
  await twin("stash drop out of range", p7s, ["stash", "drop", "7"], ss);
  await twin("stash drop bad", p7s, ["stash", "drop", "nope"], ss);
  await twin("stash clear", p7s, ["stash", "clear"], ss);
  await twin("stash on a list", p7s, ["stash"], { ...ss, setup: (d) => write(d, "a.txt", "fourth\n") });
  // in the middle of a merge: refused while paths are unmerged, applied once they are resolved
  const midMerge = (d: string) => {
    nat(d, "switch", "-qc", "side");
    write(d, "a.txt", "side\n");
    nat(d, "commit", "-qam", "side");
    nat(d, "switch", "-q", "-");
    write(d, "a.txt", "here\n");
    nat(d, "commit", "-qam", "here");
    natIn(d, "merge", "side");
  };
  for (const a of [["apply"], ["pop"], ["apply", "--index", "1"]]) await twin(`stash ${a.join(" ")} mid-merge`, p7s, ["stash", ...a], { ...ss, setup: midMerge, head: "tree" });
  await twin("stash apply in a resolved merge", p7s, ["stash", "apply", "1"], { ...ss, setup: (d) => { midMerge(d); write(d, "a.txt", "both\n"); nat(d, "add", "a.txt"); }, head: "tree" });

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
