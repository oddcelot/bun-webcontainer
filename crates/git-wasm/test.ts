// Runs target/wasm32-wasip1/release/git.wasm under node's WASI with a temp dir preopened as `/` (cwd `/`), through a
// scripted session, and checks every step against native git: status, log, diff, show, `git fsck --full`.
// Also reads a `git clone --no-local` of this repo (packed objects). Build first: `moon run git-wasm:build`.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject() as WebAssembly.Imports);
    const code = wasi.start(instance) as number;
    return { code, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}
function native(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_PAGER: "cat" } });
  if (r.status !== 0) throw new Error(`native git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
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
