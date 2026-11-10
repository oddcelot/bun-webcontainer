// node apps/playground/src/git/parse.test.ts   (node >= 26 runs the TypeScript directly)
// The Git panel's parsers on what native git prints in a temporary repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_FORMAT, parseBranches, parseLog, parseStatus, stagedChanges, worktreeChanges } from "./parse.ts";

const dir = mkdtempSync(join(tmpdir(), "git-parse-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "Ann Ex", GIT_AUTHOR_EMAIL: "ann@example.com", GIT_COMMITTER_NAME: "Ann Ex", GIT_COMMITTER_EMAIL: "ann@example.com", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const status = (...extra: string[]) => parseStatus(git("status", "--porcelain", "-b", "-z", ...extra));

try {
  git("init", "-q", "-b", "main");
  // unborn
  put("a.ts", "1\n");
  put("dir with space/b.ts", "b\n");
  let s = status();
  assert.equal(s.branch, "main");
  assert.equal(s.unborn, true);
  assert.deepEqual(s.entries.map((e) => [e.x + e.y, e.path]), [["??", "a.ts"], ["??", "dir with space/"]]);
  assert.deepEqual(worktreeChanges(s.entries), [
    { path: "a.ts", code: "U", dir: false },
    { path: "dir with space/", code: "U", dir: true },
  ]);
  assert.deepEqual(status("-uall").entries.map((e) => e.path), ["a.ts", "dir with space/b.ts"]);
  assert.deepEqual(stagedChanges(s.entries), []);

  git("add", "-A");
  s = status();
  assert.deepEqual(stagedChanges(s.entries).map((c) => [c.code, c.path]), [["A", "a.ts"], ["A", "dir with space/b.ts"]]);
  assert.deepEqual(worktreeChanges(s.entries), []);
  assert.throws(() => git("log", `--format=${LOG_FORMAT}`, "-n", "50"), /does not have any commits yet/);

  git("commit", "-q", "-m", "first: ünïcode subject");
  put("c.ts", "c\n");
  put("old.ts", "x\ny\nz\nw\n");
  git("add", "old.ts");
  git("commit", "-q", "-m", "second");

  // modified (staged and not), deleted, renamed, untracked, staged-then-modified
  put("a.ts", "2\n");
  git("add", "a.ts");
  put("a.ts", "3\n");
  rmSync(join(dir, "dir with space/b.ts"));
  git("mv", "old.ts", "new.ts");
  put("c.ts", "c2\n");
  put("u/deep/f.ts", "u\n");
  s = status();
  assert.equal(s.branch, "main");
  assert.equal(s.unborn, false);
  assert.deepEqual(stagedChanges(s.entries).map((c) => [c.code, c.path, c.orig]), [["M", "a.ts", undefined], ["R", "new.ts", "old.ts"]]);
  assert.deepEqual(worktreeChanges(s.entries).map((c) => [c.code, c.path]), [["M", "a.ts"], ["D", "dir with space/b.ts"], ["U", "c.ts"], ["U", "u/"]]);

  // branches, detached HEAD, log
  git("switch", "-q", "-c", "feature/x");
  assert.equal(status().branch, "feature/x");
  assert.deepEqual(parseBranches(git("branch", "--format=%(refname:short)")), ["feature/x", "main"]);
  assert.deepEqual(parseBranches("* main\n  dev\n"), ["main", "dev"]);
  assert.equal(git("branch", "--show-current").trim(), "feature/x");
  git("checkout", "-q", "--detach", "HEAD");
  assert.equal(status().branch, null);
  assert.deepEqual(parseBranches(git("branch", "--format=%(refname:short)")), ["feature/x", "main"]);
  git("switch", "-q", "main");

  const log = parseLog(git("log", `--format=${LOG_FORMAT}`, "-n", "50"));
  assert.deepEqual(log.map((c) => c.subject), ["second", "first: ünïcode subject"]);
  assert.equal(log[0].author, "Ann Ex");
  assert.equal(log[0].email, "ann@example.com");
  assert.match(log[0].hash, /^[0-9a-f]{40}$/);
  assert.equal(log[0].hash.startsWith(log[0].short), true);
  assert.ok(Math.abs(Date.now() / 1000 - log[0].time) < 120);

  // synthetic forms of the header
  assert.deepEqual(parseStatus("## main...origin/main [ahead 1, behind 2]\0 M x\0"), { branch: "main", unborn: false, upstream: "origin/main", entries: [{ x: " ", y: "M", path: "x" }] });
  assert.equal(parseStatus("## Initial commit on dev\0").branch, "dev");
  assert.deepEqual(worktreeChanges(parseStatus("## main\0UU z\0").entries), [{ path: "z", code: "!" }]);
  console.log("ok   git parsers vs native git");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
