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
  await twin("switch carries dirty file", p3, ["switch", "feat"], { setup: (d) => write(d, "c.txt", "c dirty\n"), out: true, err: true });
  await twin("switch carries staged file", p3, ["switch", "feat"], { setup: (d) => { write(d, "c.txt", "c staged\n"); nat(d, "add", "c.txt"); }, out: true });
  // the changes checkout carries over: `M\tc.txt`, staged new `A`, deleted `D`, staged and changed again; none with -q, -f or -c alone
  const carried = (d: string) => { write(d, "c.txt", "c dirty\n"); write(d, "s p.txt", "s\n"); write(d, "gone.txt", "g\n"); nat(d, "add", "s p.txt", "gone.txt"); rmSync(join(d, "gone.txt")); write(d, "dir/z.txt", "z\n"); nat(d, "add", "dir/z.txt"); write(d, "dir/z.txt", "z2\n"); write(d, "u.txt", "u\n"); };
  for (const a of [["switch", "feat"], ["checkout", "feat"], ["checkout", "-q", "feat"], ["switch", "main"], ["checkout", "main"], ["switch", "-c", "nb"], ["switch", "-c", "nb", "feat"], ["checkout", "-b", "nb", "main"], ["checkout", "--detach"], ["switch", "--detach", "feat"], ["checkout", "-f", "feat"]]) {
    await twin(`${a.join(" ")} lists carried changes`, p3, a, { setup: carried, out: true, err: true });
  }
  await twin("checkout b.txt deleted lists D", p3, ["checkout", "feat"], { setup: (d) => rmSync(join(d, "c.txt")), out: true, err: true });
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
  // detaching: git's advice from a branch (not with --detach), `Previous HEAD position was`, the lost commits' warning
  await twin("checkout rev: detach advice", p3, ["checkout", "feat^0"], { out: true, err: true });
  await twin("checkout tag-like rev: advice names it", p3, ["checkout", "feat~1"], { out: true, err: true });
  await twin("checkout --detach: no advice", p3, ["checkout", "--detach", "feat"], { out: true, err: true });
  await twin("checkout rev: advice.detachedHead=false", p3, ["checkout", "feat^0"], { out: true, err: true, setup: (d) => nat(d, "config", "advice.detachedHead", "false") });
  const p3d = join(tmp, "p3d");
  cpSync(p3, p3d, { recursive: true });
  nat(p3d, "checkout", "-q", "--detach", "feat");
  await twin("detached -> branch: previous position", p3d, ["checkout", "main"], { out: true, err: true });
  await twin("detached -> rev: previous position", p3d, ["checkout", "HEAD~1"], { out: true, err: true });
  await twin("detached -> switch -c start", p3d, ["switch", "-c", "topic", "main"], { out: true, err: true });
  await twin("detached -> same commit: nothing", p3d, ["checkout", "feat"], { out: true, err: true });
  for (const n of [1, 2, 5, 6]) {
    const lost = join(tmp, `p3lost${n}`);
    cpSync(p3d, lost, { recursive: true });
    for (let i = 1; i <= n; i++) nat(lost, "commit", "-q", "--allow-empty", "-m", `lost ${i}`);
    await twin(`leaving ${n} lost commits`, lost, ["switch", "main"], { out: true, err: true });
    if (n === 1) {
      await twin("leaving lost commits -q", lost, ["checkout", "-q", "main"], { out: true, err: true });
      await twin("leaving lost commits, advice off", lost, ["checkout", "main"], { out: true, err: true, setup: (d) => nat(d, "config", "advice.detachedHead", "false") });
      await twin("leaving lost commits for a rev", lost, ["checkout", "main^0"], { out: true, err: true });
    }
  }
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
  // strategies (-s) and their options (-X)
  const strategies = [
    ["-s", "ours", "feat"], ["--strategy=ours", "--no-commit", "feat"], ["-sours", "--squash", "feat"], ["-s", "ours", "--ff-only", "feat"], ["-s", "ours", "main"],
    ["-s", "recursive", "feat"], ["--strategy", "ort", "feat"], ["-s", "nope", "feat"], ["-s"], ["-X"],
    ["-X", "ours", "feat"], ["-Xtheirs", "feat"], ["--strategy-option=theirs", "--no-commit", "feat"], ["-s", "recursive", "-X", "theirs", "feat"],
    ["-X", "no-renames", "feat"], ["-X", "find-renames=50%", "feat"], ["-X", "rename-threshold=9", "feat"], ["-X", "histogram", "feat"], ["-X", "diff-algorithm=minimal", "feat"],
    ["-X", "bogus", "feat"], ["-X", "find-renames=abc", "feat"], ["-X", "diff-algorithm=nope", "feat"], ["-s", "ours", "-X", "bogus", "feat"],
  ];
  for (const a of strategies) await twin(`merge ${a.join(" ")}`, p5c, ["merge", ...a], ms);
  await twin("merge -s ours ff possible", p5, ["merge", "-s", "ours", "feat"], ms);
  await twin("merge -s ours dirty elsewhere", p5c, ["merge", "-s", "ours", "feat"], { ...ms, setup: (d) => write(d, "k.txt", "dirty\n") });
  await twin("merge -s ours refuses staged", p5c, ["merge", "-s", "ours", "feat"], { ...ms, setup: (d) => { write(d, "k.txt", "staged\n"); nat(d, "add", "k.txt"); } });
  await twin("merge -s ours octopus", p8, ["merge", "-s", "ours", "b1", "b2"], ms);
  await twin("merge -s octopus", p8, ["merge", "-s", "octopus", "b1", "b2", "b3"], ms);
  await twin("merge -X theirs octopus", p8, ["merge", "-X", "theirs", "b1", "b2", "b4"], { ...ms, markers: true });
  await twin("merge -s octopus fast-forward", p5, ["merge", "-s", "octopus", "feat"], ms);
  for (const a of [["-s", "resolve", "feat"], ["-s", "subtree", "feat"], ["-s", "octopus", "feat"], ["-s", "ort", "b1", "b2"], ["-X", "patience", "feat"], ["-X", "ignore-space-change", "feat"]]) {
    const p = a.includes("b1") ? p8 : p5c;
    r = await git(p, ["merge", ...a], ident);
    check(`merge ${a.join(" ")} unsupported`, r.code === 128 && /^fatal: .*(not supported|merges one branch|needs two or more)/.test(r.err) && !existsSync(join(p, ".git/MERGE_HEAD")), JSON.stringify(r));
  }
  await twin("merge -X theirs status", p5c, ["merge", "-X", "theirs", "feat"], { ...ms, extra: (d) => mergeState(d) + longStatus(d) });

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
  // --sort and --contains
  const p6v = join(tmp, "p6v");
  cpSync(p6, p6v, { recursive: true });
  for (const t of ["v1.10", "v1.9", "v1.9-rc1", "v2.0", "v10", "v1.09", "v1.009"]) nat(p6v, "tag", t, "HEAD~1");
  const dated = (name: string, date: string, ...rest: string[]) => spawnSync("git", ["-C", p6v, "tag", "-a", name, "-m", name, ...rest], { env: { ...natEnv, GIT_COMMITTER_DATE: date } });
  dated("old", "2001-01-01T00:00:00Z", "HEAD~1");
  dated("future", "2101-01-01T00:00:00Z", "HEAD~1");
  nat(p6v, "tag", "tree", "HEAD^{tree}");
  const sorts = [["--sort=refname"], ["--sort=-refname"], ["--sort=version:refname"], ["--sort=-v:refname"], ["--sort", "creatordate"], ["--sort=-creatordate"], ["--sort=objectname"], ["--sort=refname", "--sort=-creatordate"], ["--sort=-v:refname", "-l", "v1*"], ["-n", "--sort=-version:refname"], ["--sort=nope"], ["--sort"], ["--sort=-creatordate", "--no-sort"]];
  const containing = [["--contains"], ["--contains", "HEAD~1"], ["--contains=HEAD"], ["--contains", "feat"], ["--contains", "ann"], ["--no-contains", "HEAD"], ["--contains", "HEAD~1", "--no-contains", "HEAD"], ["--contains", "HEAD~1", "--sort=-v:refname"], ["-l", "--contains"], ["--contains", "HEAD~1", "v*"], ["--contains", "nope"], ["--contains", "tree"], ["--contains", "HEAD~1", "--contains", "HEAD"]];
  for (const a of [...sorts, ...containing]) await twin(`tag ${a.join(" ")}`, p6v, ["tag", ...a], ts);
  await twin("tag --sort creates", p6v, ["tag", "--sort=refname", "newtag"], ts);
  await twin("tag.sort", p6v, ["tag"], { ...ts, setup: (d) => nat(d, "config", "tag.sort", "-version:refname") });
  await twin("tag.sort, --sort wins", p6v, ["tag", "--sort=refname"], { ...ts, setup: (d) => nat(d, "config", "tag.sort", "-version:refname") });
  // versionsort.suffix: prereleases before the release, in the suffixes' order (and git's quirks where they overlap)
  const pre = join(tmp, "p6pre");
  cpSync(p6v, pre, { recursive: true });
  for (const t of ["v2.0-rc1", "v2.0-rc2", "v2.0-beta", "v2.0-beta2", "v2.0.1", "v2.0-pre", "v2.0-bfoo", "v2.0-rc"]) nat(pre, "tag", t, "HEAD~1");
  const suffixes = (...values: string[]) => (d: string) => { for (const v of values) nat(d, "config", "--add", "versionsort.suffix", v); };
  for (const [name, sfx] of [["-rc", ["-rc"]], ["-beta -rc", ["-beta", "-rc"]], ["-rc -beta -pre", ["-rc", "-beta", "-pre"]], ["-b -beta (overlap)", ["-b", "-beta"]], [". (dots)", ["."]], ["none set", []]] as const) {
    await twin(`tag versionsort.suffix ${name}`, pre, ["tag", "--sort=v:refname", "-l", "v2*"], { ...ts, setup: suffixes(...sfx) });
    await twin(`tag versionsort.suffix ${name}, reversed`, pre, ["tag", "--sort=-version:refname"], { ...ts, setup: suffixes(...sfx) });
  }
  // -F, the message cleanup, --points-at, --merged, --format, -i
  const msgFile = (d: string) => write(d, "msg.txt", "  \n\nfirst line   \n# a comment\n\n\n\nsecond\n\n");
  const tagF = [["-F", "msg.txt", "f1"], ["--file=msg.txt", "f2", "feat"], ["-a", "-F", "msg.txt", "f3"], ["-Fmsg.txt", "f4"], ["-F", "msg.txt", "-m", "x", "f5"], ["-F", "nope.txt", "f6"], ["-F", "comments.txt", "f7"], ["-m", "a\n# c\n\nb  ", "f8"], ["-m", "one", "-m", "\n\ntwo\n\n", "f9"], ["-F"]];
  for (const a of tagF) await twin(`tag ${a.join(" ")}`, p6, ["tag", ...a], { ...ts, setup: (d) => { msgFile(d); write(d, "comments.txt", "# only\n"); } });
  const filters = [["--points-at"], ["--points-at", "HEAD~1"], ["--points-at", "feat"], ["--points-at", native(p6v, ["rev-parse", "ann"]).trim()], ["--points-at=feat", "l*"], ["--points-at", "nope"], ["--merged"], ["--merged", "HEAD~1"], ["--merged=feat"], ["--no-merged"], ["--no-merged", "HEAD~1"], ["--merged", "HEAD", "--no-merged", "HEAD~1"], ["--merged", "nope"], ["--merged", "HEAD~1", "--sort=-v:refname", "v1*"]];
  const formats = ["%(refname)", "%(refname:short) %(objecttype) %(*objecttype) %(objectname:short) %(*objectname)", "%(refname:lstrip=1)|%(refname:strip=2)|%(objectname:short=10)", "%(subject)|%(body)|%(contents:subject)|%(contents:body)|%(contents)", "%(contents:lines=1)|%(contents:lines=2)", "%(taggername) %(taggeremail) %(taggeremail:trim) %(*authorname) %(*authoremail) %(tag) %(type)", "%(creatordate)|%(creatordate:short)|%(taggerdate:iso)|%(*committerdate:unix)|%(creatordate:raw)", "%(objectsize) %(*subject)", "100%% %41%2a %zz %", "", "%(nope)", "%(refname",
    // %(align) and %(if): padding, nesting, the comparisons, and git's errors for misuse
    "%(align:12)%(refname:short)%(end)|", "%(align:12,right)%(refname:short)%(end)|%(align:position=middle,width=9)%(objecttype)%(end)|", "%(align:width=3)%(refname:short)%(end)|",
    "%(align:16,middle)[%(align:6,right)%(objecttype)%(end)]%(end)|", "%(align)x%(end)", "%(align:wide)x%(end)", "%(align:5,top)x%(end)", "%(align:5,position=top)x%(end)",
    "%(refname:short) %(if)%(*objecttype)%(then)annotated %(*objecttype)%(else)lightweight%(end)", "%(if)%(contents:body)%(then)has a body%(end)",
    "%(if:equals=commit)%(objecttype)%(then)c%(else)not c: %(objecttype)%(end)", "%(if:notequals=v1.9)%(refname:short)%(then)%(refname:short)%(end)",
    "%(if)%(taggername)%(then)%(align:10,right)%(taggername)%(end)%(else)-%(end)|", "%(if)%(if)%(tag)%(then)x%(end)%(then)nested%(else)none%(end)",
    "%(if) %(then)space%(else)blank%(end)", "%(then)", "%(if)x%(else)y%(end)", "%(if)x%(then)y%(then)z%(end)", "%(if)x%(then)y%(else)z%(else)w%(end)", "%(if)x%(then)y%(else)z%(then)%(end)",
    "%(if)x%(end)", "%(end)", "%(if)x%(then)y", "%(align:4)x", "%(if:sure)x%(then)%(end)", "%(then:x)", "%(else)", "%(if)x%(then)%(end:y)|"];
  for (const a of [...filters, ...formats.map((f) => [`--format=${f}`]), ["--format", "%(refname:short)", "-l", "[a-l]*"], ["--format"], ["-n", "--format=%(refname)"]]) await twin(`tag ${a.join(" ")}`, p6v, ["tag", ...a], ts);
  const mixed = (d: string) => { nat(d, "tag", "Alpha"); nat(d, "tag", "beta"); nat(d, "tag", "BETA2"); };
  for (const a of [["-i"], ["-i", "-l", "b*"], ["-l", "b*"], ["--ignore-case", "--sort=-refname", "-l", "*A*"], ["-i", "--sort=v:refname"]]) await twin(`tag ${a.join(" ")}`, p6, ["tag", ...a], { ...ts, setup: mixed });
  for (const a of [["-s", "v9"], ["-u", "key", "v9"], ["--sign", "-m", "x", "v9"], ["-F", "-", "v9"]]) {
    r = await git(p6, ["tag", ...a], ident);
    check(`tag ${a.join(" ")} unsupported`, r.code === 128 && /not supported in the playground/.test(r.err) && !existsSync(join(p6, ".git/refs/tags/v9")), JSON.stringify(r));
  }
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
  // --keep-index, --all, pathspecs
  const ignored = (d: string) => {
    dirty(d);
    writeFileSync(join(d, ".git/info/exclude"), "*.log\nbuild/\n");
    write(d, "debug.log", "log\n");
    write(d, "build/out.js", "out\n");
    write(d, "build/deep/more.js", "more\n");
  };
  for (const a of [["-k"], ["--keep-index", "-u"], ["push", "-k", "-m", "kept"]]) await twin(`stash ${a.join(" ")}`, p7, ["stash", ...a], { ...ss, setup: dirty });
  same("native pops our -k stash", (natIn(A, "stash", "pop", "--index"), state(A)), (natIn(B, "stash", "pop", "--index"), state(B)));
  for (const a of [["-a"], ["--all", "-k"], ["-a", "--", "build"], ["-u"]]) await twin(`stash ${a.join(" ")} (ignored files)`, p7, ["stash", ...a], { ...ss, setup: ignored });
  same("native pops our -a stash", (natIn(A, "stash", "pop"), state(A)), (natIn(B, "stash", "pop"), state(B)));
  await twin("stash -a -u", p7, ["stash", "-a", "-u"], { ...ss, setup: ignored, out: false, err: false });
  for (const a of [["push", "--", "a.txt"], ["push", "a.txt", "b.txt"], ["--", "k.txt"], ["--", "n2.txt"], ["push", "-m", "some", "--", "a.txt"], ["-u", "--", "u.txt"], ["-u", "ud"], ["push", "-u", "ud"], ["-u", "--", "a.txt", "ud/deep.txt"], ["-k", "--", "b.txt"], ["-k", "--", "a.txt", "n2.txt"], ["-q", "--", "a.txt"], ["--", "."], ["--", "dir"], ["--", "nope"], ["--", "a.txt", "nope"], ["--", "u.txt"]]) {
    await twin(`stash ${a.join(" ")}`, p7, ["stash", ...a], { ...ss, setup: dirty });
  }
  same("native pops our pathspec stash", (natIn(A, "stash", "pop", "--index"), state(A)), (natIn(B, "stash", "pop", "--index"), state(B)));
  await twin("stash -- path without changes", p7, ["stash", "--", "dir"], ss);
  // --staged: only what is staged, taken out of the index and the worktree (changes made on top of it stay)
  const stagedOnTop = (d: string) => { dirty(d); write(d, "a.txt", "a\nB\nc\n"); nat(d, "add", "a.txt"); write(d, "a.txt", "a\nB\nc\nA\n"); };
  for (const a of [["-S"], ["push", "--staged", "-m", "only staged"], ["--staged", "-k"], ["-S", "--", "n2.txt"], ["-S", "--", "k.txt"], ["-S", "-u"], ["push", "-S", "-a"], ["-q", "-S"]]) {
    await twin(`stash ${a.join(" ")}`, p7, ["stash", ...a], { ...ss, setup: stagedOnTop });
  }
  same("native pops our --staged stash", (natIn(A, "stash", "pop", "--index"), state(A)), (natIn(B, "stash", "pop", "--index"), state(B)));
  await twin("stash -S nothing staged", p7, ["stash", "-S"], { ...ss, setup: (d) => write(d, "a.txt", "unstaged\n") });
  await twin("stash push -S nothing staged", p7, ["stash", "push", "-S"], { ...ss, setup: (d) => write(d, "a.txt", "unstaged\n") });
  await twin("stash -S nothing at all", p7, ["stash", "-S"], ss);
  // the staged change and the worktree's conflict: git apply -R fails, the stash is kept and nothing else changes
  const cantRemove = (d: string) => { write(d, "a.txt", "a\nB\nc\n"); nat(d, "add", "a.txt"); write(d, "a.txt", "a\nC\nc\n"); };
  await twin("stash -S can't remove", p7, ["stash", "-S"], { ...ss, err: false, setup: cantRemove });
  await twin("stash push -S can't remove", p7, ["stash", "push", "-S"], { ...ss, err: false, setup: cantRemove });
  r = await git(p7, ["stash", "-p"], ident);
  check("stash -p unsupported", r.code === 128 && r.err.includes("--patch") && r.err.includes("git stash push -- <path>") && !existsSync(join(p7, ".git/refs/stash")), JSON.stringify(r));
  // create: the stash commit without touching anything; store: put one on the list
  const stashCommit = (d: string, id: string) => !id ? "-" : ["%T|%s|%B", "%T", "%T"].map((f, i) => natIn(d, "log", "-1", `--format=${f}`, [id, `${id}^1`, `${id}^2`][i]).stdout).join("|");
  for (const a of [[], ["my", "message"], ["-u"]]) {
    for (const d of [A, B]) {
      rmSync(d, { recursive: true, force: true });
      cpSync(p7, d, { recursive: true });
      dirty(d);
    }
    const ours = await git(A, ["stash", "create", ...a], ident);
    const nativeRun = natIn(B, "stash", "create", ...a);
    check(`stash create ${a.join(" ")}: exit`, ours.code === nativeRun.status && ours.err === nativeRun.stderr, JSON.stringify(ours));
    same(`stash create ${a.join(" ")}: commit`, stashCommit(A, ours.out.trim()), stashCommit(B, nativeRun.stdout.trim()));
    same(`stash create ${a.join(" ")}: state`, state(A) + stashState(A), state(B) + stashState(B));
  }
  await twin("stash create clean", p7, ["stash", "create"], ss);
  const made = (d: string) => { dirty(d); const id = natIn(d, "stash", "create").stdout.trim(); nat(d, "update-ref", "refs/heads/made", id); nat(d, "reset", "-q", "--hard"); };
  for (const a of [["made"], ["-m", "custom", "made"], ["-q", "made"], ["HEAD"], ["nope"], [], ["made", "HEAD"]]) await twin(`stash store ${a.join(" ")}`, p7s, ["stash", "store", ...a], { ...ss, setup: made });
  await twin("stash store twice", p7s, ["stash", "store", "made"], { ...ss, setup: (d) => { made(d); nat(d, "stash", "store", "made"); } });
  // stash branch: a branch at the stash's base, the stash applied with --index and dropped
  for (const a of [["nb"], ["nb", "1"], ["nb", "stash@{2}"], [], ["main"], ["nb", "7"]]) await twin(`stash branch ${a.join(" ")}`, p7s, ["stash", "branch", ...a], ss);
  await twin("stash branch with local changes in the way", p7s, ["stash", "branch", "nb"], { ...ss, setup: (d) => write(d, "b.txt", "mine\n") });
  // (stderr: git apply's `error: patch failed: b.txt:1` lines come first)
  await twin("stash apply --index conflict", p7s, ["stash", "apply", "--index"], { ...ss, err: false, setup: (d) => { write(d, "b.txt", "conflicting\n"); nat(d, "commit", "-qam", "conflicting"); }, head: "tree" });

  // ---- status: the branch against its upstream ---------------------------------------------------------------------
  {
    const ps = join(tmp, "ps");
    mkdirSync(ps);
    const psn = (...args: string[]) => nat(ps, ...args);
    psn("init", "-q", "-b", "main");
    psn("config", "core.fileMode", "false");
    let n = 0;
    const commit = () => { write(ps, "f.txt", `${++n}\n`); psn("add", "f.txt"); psn("commit", "-qm", `c${n}`); };
    commit();
    commit();
    psn("branch", "up");
    psn("switch", "-qc", "t");
    psn("branch", "-q", "--set-upstream-to=up");
    const compare = async (at: string) => {
      for (const args of [["status"], ["status", "-sb"]]) same(`status tracking, ${at}: ${args.join(" ")}`, (await git(ps, args, ident)).out, native(ps, args));
      // commit's (nothing to commit) leaves out the hint on a diverged branch
      const nc = spawnSync("git", ["-C", ps, "commit", "-m", "x"], { encoding: "utf8", env: natEnv });
      same(`status tracking, ${at}: commit`, (await git(ps, ["commit", "-m", "x"], ident)).out, nc.stdout);
    };
    await compare("up to date");
    commit();
    await compare("ahead 1");
    commit();
    await compare("ahead 2");
    psn("switch", "-q", "up");
    commit();
    psn("switch", "-q", "t");
    await compare("diverged");
    psn("reset", "-q", "--hard", "up~1");
    await compare("behind 1");
    psn("reset", "-q", "--hard", "up~2");
    await compare("behind 2");
    psn("tag", "up", "main");
    await compare("ambiguous");
    psn("branch", "-q", "-D", "up");
    await compare("gone");
    psn("tag", "-d", "up");
    await compare("gone, unambiguous");
    psn("update-ref", "refs/remotes/origin/main", "main");
    psn("config", "branch.t.remote", "origin");
    psn("config", "branch.t.merge", "refs/heads/main");
    await compare("a remote that isn't configured");
    psn("config", "remote.origin.url", "https://example.com/r.git");
    psn("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await compare("a remote's");
    psn("config", "advice.statusHints", "false");
    await compare("statusHints off");
  }

  // ---- rebase -------------------------------------------------------------------------------------------------------
  // Sequences of steps on two copies: ours (A) and native git (B), compared after each step. New commits' ids differ
  // (their committer time), so ids the source project doesn't have are masked in the output.
  const pr = join(tmp, "pr");
  mkdirSync(pr);
  const fixed = { ...natEnv, GIT_AUTHOR_DATE: "1700000000 +0100", GIT_COMMITTER_DATE: "1700000000 +0100" };
  const prn = (...args: string[]) => {
    const x = spawnSync("git", ["-C", pr, ...args], { encoding: "utf8", env: fixed });
    if (x.status !== 0) throw new Error(`native ${args.join(" ")}: ${x.stderr}`);
    return x.stdout;
  };
  prn("init", "-q", "-b", "main");
  prn("config", "core.fileMode", "false");
  write(pr, "f.txt", "a\nb\nc\nd\ne\nf\ng\n");
  write(pr, "k.txt", "keep\n");
  prn("add", ".");
  prn("commit", "-qm", "base");
  prn("branch", "behind");
  prn("switch", "-qc", "feat");
  write(pr, "f.txt", "a\nb\nc\nd\ne\nf\nG\n");
  prn("commit", "-qam", "f1: last line");
  write(pr, "n.txt", "new\n");
  prn("add", "n.txt");
  prn("commit", "-qm", "f2: add n", "-m", "with a body");
  prn("commit", "-q", "--allow-empty", "-m", "f3: empty");
  write(pr, "f.txt", "a\nb\nc\nD\ne\nf\nG\n");
  prn("commit", "-qam", "f4: line d");
  prn("switch", "-q", "main");
  write(pr, "f.txt", "A\nb\nc\nd\ne\nf\ng\n");
  prn("commit", "-qam", "m1: first line");
  prn("branch", "m1");
  write(pr, "x.txt", "x\n");
  prn("add", "x.txt");
  prn("commit", "-qm", "m2: add x");
  prn("switch", "-q", "feat");
  // conflicting upstreams: line d changed differently (f4 conflicts), and line g as f1 has it (f1 already applied)
  prn("branch", "dconf", "main");
  prn("branch", "same", "main");
  prn("switch", "-q", "dconf");
  write(pr, "f.txt", "A\nb\nc\nDD\ne\nf\ng\n");
  prn("commit", "-qam", "dc: line d");
  prn("switch", "-q", "same");
  write(pr, "f.txt", "A\nb\nc\nd\ne\nf\nG\n");
  prn("commit", "-qam", "s: last line too");
  prn("switch", "-q", "--detach", "main");
  prn("switch", "-q", "feat");
  const known = new Set(prn("rev-list", "--all").split("\n").filter(Boolean));
  const mask = (t: string) => t.replace(/\b[0-9a-f]{7,40}\b/g, (m) => ([...known].some((k) => k.startsWith(m)) ? m : "<new>"));
  const rebaseFiles = (d: string) =>
    ["head-name", "onto", "orig-head", "msgnum", "end", "git-rebase-todo", "done", "stopped-sha", "../REBASE_HEAD", "../MERGE_MSG", "../ORIG_HEAD"]
      .map((f) => `${f}: ${existsSync(join(d, ".git/rebase-merge", f)) ? mask(readFileSync(join(d, ".git/rebase-merge", f), "utf8")) : "-"}`)
      .join("\n") + `\nrebasing: ${existsSync(join(d, ".git/rebase-merge"))}`;
  const chain = (d: string) => mask(spawnSync("git", ["-C", d, "log", "--format=%T|%an|%ae|%at|%B|%H", "HEAD", "--"], { encoding: "utf8", env: natEnv }).stdout);
  const branchAt = (d: string) => mask(spawnSync("git", ["-C", d, "log", "-1", "--format=%T %H", "feat"], { encoding: "utf8", env: natEnv }).stdout);
  // a step: the same git command on both, a change to both copies, or our command and native's equivalent
  type Step = string[] | ((d: string) => void) | { ours: string[]; native: string[] };
  async function rebaseSeq(name: string, steps: Step[], setup?: (d: string) => void) {
    for (const d of [A, B]) {
      rmSync(d, { recursive: true, force: true });
      cpSync(pr, d, { recursive: true });
      spawnSync("git", ["-C", d, "update-index", "-q", "--refresh"], { env: natEnv });
      setup?.(d);
    }
    for (const [i, step] of steps.entries()) {
      if (typeof step === "function") {
        step(A);
        step(B);
        continue;
      }
      const [oursArgs, nativeArgs] = Array.isArray(step) ? [step, step] : [step.ours, step.native];
      const at = `${name} #${i} git ${oursArgs.join(" ")}`;
      const ours = await git(A, oursArgs, ident);
      const nat = spawnSync("git", ["-C", B, ...nativeArgs], { encoding: "utf8", env: natEnv });
      check(`${at}: exit`, ours.code === nat.status, `ours ${ours.code} native ${nat.status}\n${ours.err}\n${nat.stderr}`);
      same(`${at}: stdout`, mask(ours.out), mask(nat.stdout));
      same(`${at}: stderr`, mask(ours.err), mask(nat.stderr));
      same(`${at}: state`, [native(A, ["status", "--porcelain", "-b", "-uall"]), native(A, ["ls-files", "-s"]), files(A).join("\n"), chain(A), branchAt(A), rebaseFiles(A)].join("\n--\n"),
        [native(B, ["status", "--porcelain", "-b", "-uall"]), native(B, ["ls-files", "-s"]), files(B).join("\n"), chain(B), branchAt(B), rebaseFiles(B)].join("\n--\n"));
      // the long status, ours and native's on our state
      same(`${at}: status`, mask((await git(A, ["status"], ident)).out), mask(native(B, ["status"])));
      same(`${at}: native status of ours`, mask(native(A, ["status"])), mask(native(B, ["status"])));
      if (spawnSync("git", ["-C", A, "fsck", "--full", "--strict"], { env: natEnv }).status !== 0) check(`${at}: fsck`, false, spawnSync("git", ["-C", A, "fsck", "--full", "--strict"], { encoding: "utf8", env: natEnv }).stderr);
    }
  }
  const resolve = (text: string) => (d: string) => { write(d, "f.txt", text); spawnSync("git", ["-C", d, "add", "f.txt"], { env: natEnv }); };
  await rebaseSeq("rebase clean", [["rebase", "main"], ["rebase", "main"]]);
  await rebaseSeq("rebase -q", [["rebase", "-q", "main"]]);
  await rebaseSeq("rebase up to date", [["rebase", "feat~2"], ["rebase", "-q", "base"]], (d) => nat(d, "tag", "base", "main~2"));
  await rebaseSeq("rebase fast-forward", [["rebase", "main"]], (d) => nat(d, "switch", "-q", "behind"));
  await rebaseSeq("rebase --onto", [["rebase", "--onto", "main", "feat~2"]]);
  await rebaseSeq("rebase --onto=", [["rebase", "--onto=m1", "feat~3"]]);
  await rebaseSeq("rebase detached", [["rebase", "main"]], (d) => nat(d, "switch", "-q", "--detach", "feat"));
  await rebaseSeq("rebase without upstream", [["rebase"]]);
  await rebaseSeq("rebase bad upstream", [["rebase", "nope"]]);
  await rebaseSeq("rebase dirty", [["rebase", "main"]], (d) => write(d, "f.txt", "dirty\n"));
  await rebaseSeq("rebase staged", [["rebase", "main"]], (d) => { write(d, "n.txt", "staged\n"); nat(d, "add", "n.txt"); });
  await rebaseSeq("rebase staged and dirty", [["rebase", "main"]], (d) => { write(d, "n.txt", "staged\n"); nat(d, "add", "n.txt"); write(d, "k.txt", "dirty\n"); });
  await rebaseSeq("rebase untracked beside", [["rebase", "main"]], (d) => write(d, "u.txt", "mine\n"));
  await rebaseSeq("rebase untracked in the way", [["rebase", "main"]], (d) => write(d, "x.txt", "mine\n"));
  await rebaseSeq("rebase drops what upstream has", [["rebase", "same"]]);
  await rebaseSeq("rebase advice.skippedCherryPicks off", [["rebase", "same"]], (d) => nat(d, "config", "advice.skippedCherryPicks", "false"));
  await rebaseSeq("rebase conflict, continue", [["rebase", "dconf"], ["status", "-s"], ["rebase", "--continue"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), ["status", "-s"], ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, continue -q", [["rebase", "-q", "dconf"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, resolved as HEAD", [["rebase", "dconf"], resolve("A\nb\nc\nDD\ne\nf\nG\n"), ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, skip", [["rebase", "dconf"], ["rebase", "--skip"]]);
  await rebaseSeq("rebase conflict, abort", [["rebase", "dconf"], ["rebase", "--abort"], ["rebase", "--abort"]]);
  await rebaseSeq("rebase conflict, quit", [["rebase", "dconf"], ["rebase", "--quit"]]);
  await rebaseSeq("rebase conflict, again", [["rebase", "dconf"], ["rebase", "main"], ["switch", "main"], ["merge", "main"]]);
  await rebaseSeq("rebase conflict, unstaged at continue", [["rebase", "dconf"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), (d) => write(d, "k.txt", "dirty\n"), ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, commit then continue", [["rebase", "dconf"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), ["commit", "-q", "-m", "by hand"], ["status"], ["rebase", "--continue"]]);
  // commit without -m during a stop: MERGE_MSG, as --no-edit (there is no editor), the conflicts' comments with it
  await rebaseSeq("rebase conflict, commit without -m", [["rebase", "dconf"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), { ours: ["commit"], native: ["commit", "--no-edit"] }, ["status"], ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, commit --no-edit", [["rebase", "dconf"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), ["commit", "--no-edit", "-q"], ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict, commit -a without -m", [["rebase", "dconf"], (d) => write(d, "f.txt", "A\nb\nc\nresolved\ne\nf\nG\n"), { ours: ["commit", "-a"], native: ["commit", "-a", "--no-edit"] }, ["rebase", "--continue"]]);
  await rebaseSeq("rebase conflict -X theirs", [["rebase", "-X", "theirs", "dconf"]]);
  await rebaseSeq("rebase conflict -Xours", [["rebase", "-Xours", "dconf"]]);
  await rebaseSeq("rebase conflict, advice off", [["rebase", "dconf"]], (d) => nat(d, "config", "advice.mergeConflict", "false"));
  // rebase <upstream> <branch>: the branch is switched to first (when up to date), or rebased from wherever HEAD is
  const onMain = (d: string) => nat(d, "switch", "-q", "main");
  await rebaseSeq("rebase <upstream> <branch>", [["rebase", "main", "feat"], ["status", "-s"]], onMain);
  await rebaseSeq("rebase <upstream> <branch> on it", [["rebase", "main", "feat"]]);
  await rebaseSeq("rebase <upstream> <branch> up to date", [["rebase", "feat~2", "feat"], ["rebase", "-q", "main", "m1"]], onMain);
  await rebaseSeq("rebase <upstream> <commit>", [["rebase", "main", "feat~1"]], onMain);
  await rebaseSeq("rebase <upstream> <commit> up to date", [["rebase", "base", "feat~1"], ["rebase", "feat", "HEAD"]], (d) => { onMain(d); nat(d, "tag", "base", "main~2"); });
  await rebaseSeq("rebase <upstream> <no such branch>", [["rebase", "main", "nope"]], onMain);
  await rebaseSeq("rebase <upstream> <branch> behind", [["rebase", "main", "behind"]]);
  await rebaseSeq("rebase <upstream> <branch> with untracked in the way", [["rebase", "feat", "behind"]], (d) => { onMain(d); write(d, "n.txt", "mine\n"); });
  await rebaseSeq("rebase <upstream> <branch> conflict, abort", [["rebase", "dconf", "feat"], ["status"], ["rebase", "--abort"]], onMain);
  await rebaseSeq("rebase <upstream> <branch> conflict, continue", [["rebase", "dconf", "feat"], resolve("A\nb\nc\nresolved\ne\nf\nG\n"), ["rebase", "--continue"]], onMain);
  await rebaseSeq("rebase <upstream> <branch> --onto", [["rebase", "--onto", "m1", "feat~2", "feat"]], onMain);
  await rebaseSeq("rebase -", [["rebase", "-"]], (d) => { onMain(d); nat(d, "switch", "-q", "feat"); });
  for (const d of [A, B]) {
    rmSync(d, { recursive: true, force: true });
    cpSync(pr, d, { recursive: true });
    spawnSync("git", ["-C", d, "rebase", "dconf"], { env: natEnv });
    write(d, "f.txt", "A\nb\nc\nresolved\ne\nf\nG\n");
    nat(d, "add", "f.txt");
  }
  {
    const ours = await git(A, ["rebase", "--continue"], ident);
    const nat2 = spawnSync("git", ["-C", B, "rebase", "--continue"], { encoding: "utf8", env: natEnv });
    check("rebase: our --continue of native's stop: exit", ours.code === nat2.status, ours.err + nat2.stderr);
    same("rebase: our --continue of native's stop: state", [files(A).join("\n"), chain(A), branchAt(A), native(A, ["status", "--porcelain", "-b"])].join("\n--\n"), [files(B).join("\n"), chain(B), branchAt(B), native(B, ["status", "--porcelain", "-b"])].join("\n--\n"));
  }
  r = await git(A, ["rebase", "main", "feat", "x"], ident);
  check("rebase too many arguments: usage", r.code === 129 && r.err.startsWith("usage: git rebase [-i] [options]") && nativeCode(A, ["rebase", "main", "feat", "x"]) === 129, JSON.stringify(r));
  r = await git(A, ["rebase", "-i", "main"], ident);
  check("rebase -i refused", r.code === 128 && r.err.includes("not supported in the playground"), JSON.stringify(r));

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
