// node apps/playground/src/git/parse.test.ts   (node >= 26 runs the TypeScript directly)
// The Git panel's parsers on what native git prints in a temporary repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_FORMAT, conflictedChanges, mergeTitle, parseBranches, parseLog, parseStashes, parseStatus, stagedChanges, worktreeChanges } from "./parse.ts";

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
  assert.deepEqual(parseStatus("## main...origin/main [ahead 1, behind 2]\0 M x\0"), { branch: "main", unborn: false, upstream: "origin/main", ahead: 1, behind: 2, gone: false, entries: [{ x: " ", y: "M", path: "x" }] });
  assert.deepEqual(parseStatus("## feat...origin/feat [gone]\0"), { branch: "feat", unborn: false, upstream: "origin/feat", ahead: 0, behind: 0, gone: true, entries: [] });
  assert.deepEqual(parseStatus("## main...origin/main\0"), { branch: "main", unborn: false, upstream: "origin/main", ahead: 0, behind: 0, gone: false, entries: [] });
  assert.equal(parseStatus("## Initial commit on dev\0").branch, "dev");
  assert.deepEqual(worktreeChanges(parseStatus("## main\0UU z\0").entries), []);
  assert.deepEqual(conflictedChanges(parseStatus("## main\0UU z\0AA y\0 M x\0").entries), [{ path: "z", code: "!", conflict: "UU" }, { path: "y", code: "!", conflict: "AA" }]);

  // a merge's conflicts: content (UU), add/add (AA), modify/delete both ways (UD, DU); MERGE_MSG's title
  git("reset", "-q", "--hard");
  git("clean", "-fdq");
  git("switch", "-q", "-c", "side");
  put("a.ts", "side\n");
  put("both.ts", "side\n");
  put("dir with space/b.ts", "b on side\n");
  rmSync(join(dir, "old.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "on side");
  git("switch", "-q", "main");
  put("a.ts", "main\n");
  put("both.ts", "main\n");
  put("old.ts", "x\ny\nz\nw on main\n");
  rmSync(join(dir, "dir with space/b.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "on main");
  assert.throws(() => git("merge", "side"), (e: { stdout?: string }) => /^CONFLICT \(content\)/m.test(e.stdout ?? ""));
  s = status();
  assert.deepEqual(conflictedChanges(s.entries).map((c) => [c.conflict, c.path]), [["UU", "a.ts"], ["AA", "both.ts"], ["DU", "dir with space/b.ts"], ["UD", "old.ts"]]);
  assert.deepEqual(stagedChanges(s.entries), []);
  assert.deepEqual(worktreeChanges(s.entries), []);
  assert.equal(mergeTitle(readFileSync(join(dir, ".git/MERGE_MSG"), "utf8")), "Merge branch 'side'");
  assert.equal(mergeTitle("# Conflicts:\n#\ta.ts\n"), "");
  // what the panel's Mark as resolved runs: `add -A -- <path>`, also for a file deleted to resolve it
  rmSync(join(dir, "old.ts"));
  git("add", "-A", "--", "a.ts", "old.ts");
  assert.deepEqual(conflictedChanges(status().entries).map((c) => c.path), ["both.ts", "dir with space/b.ts"]);
  git("merge", "--abort");

  // the stash list: git's WIP message, -m messages, detached HEAD
  put("a.ts", "a3\n");
  git("stash", "-q");
  put("a.ts", "a4\n");
  git("stash", "push", "-q", "-m", "my: message");
  git("checkout", "-q", "--detach", "HEAD");
  put("a.ts", "a5\n");
  git("stash", "-q");
  git("switch", "-q", "main");
  const stashes = parseStashes(git("stash", "list"));
  assert.deepEqual(stashes.map((x) => [x.index, x.label, x.branch]), [
    [0, stashes[0].message, "(no branch)"],
    [1, "my: message", "main"],
    [2, stashes[2].message, "main"],
  ]);
  assert.match(stashes[0].message, /^WIP on \(no branch\): [0-9a-f]{7} on main$/);
  assert.match(stashes[2].message, /^WIP on main: [0-9a-f]{7} on main$/);
  assert.deepEqual(parseStashes(""), []);
  console.log("ok   git parsers vs native git");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
