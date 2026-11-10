// Parsers for the formats native git (and crates/git-wasm) print; pure, so parse.test.ts runs them on native git's output.

export type StatusEntry = {
  /** The index column of `XY` (` ` for none, `?` for untracked). */
  x: string;
  /** The worktree column. */
  y: string;
  path: string;
  /** The old path of a rename or copy. */
  orig?: string;
};

export type Status = {
  /** The branch HEAD is on; null when detached. */
  branch: string | null;
  /** The branch has no commit yet. */
  unborn: boolean;
  upstream?: string;
  entries: StatusEntry[];
};

/** `git status --porcelain -b -z` (v1). Untracked directories end with `/` unless `-uall` listed their files. */
export function parseStatus(out: string): Status {
  const parts = out.split("\0");
  const status: Status = { branch: null, unborn: false, entries: [] };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (part.startsWith("## ")) {
      const head = part.slice(3);
      const fresh = /^(?:No commits yet|Initial commit) on (.+)$/.exec(head);
      if (fresh) {
        status.unborn = true;
        status.branch = fresh[1];
      } else if (head.startsWith("HEAD (no branch)")) status.branch = null;
      else {
        const [, branch, upstream] = /^(.*?)(?:\.\.\.(\S+))?(?: \[.*\])?$/.exec(head)!;
        status.branch = branch;
        status.upstream = upstream;
      }
      continue;
    }
    const x = part[0];
    const y = part[1];
    const entry: StatusEntry = { x, y, path: part.slice(3) };
    // A rename or copy lists the new path, then the old one as its own NUL-separated field.
    if (x === "R" || x === "C" || y === "R" || y === "C") entry.orig = parts[++i];
    status.entries.push(entry);
  }
  return status;
}

/** One row of the Git panel. */
export type FileChange = {
  path: string;
  orig?: string;
  /** M modified, A added, D deleted, R renamed, C copied, T type changed, U untracked, ! conflicted. */
  code: string;
  /** An untracked directory (git lists it whole): `path` ends with `/`. */
  dir?: boolean;
};

const conflicted = (e: StatusEntry) => e.x === "U" || e.y === "U" || (e.x === "A" && e.y === "A") || (e.x === "D" && e.y === "D");

/** What is staged: the index column of each entry. */
export function stagedChanges(entries: StatusEntry[]): FileChange[] {
  return entries
    .filter((e) => e.x !== " " && e.x !== "?" && e.x !== "!" && !conflicted(e))
    .map((e) => ({ path: e.path, orig: e.orig, code: e.x }));
}

/** What is not staged: the worktree column, untracked files and conflicts. */
export function worktreeChanges(entries: StatusEntry[]): FileChange[] {
  const out: FileChange[] = [];
  for (const e of entries) {
    if (e.x === "!") continue;
    if (e.x === "?") out.push({ path: e.path, code: "U", dir: e.path.endsWith("/") });
    else if (conflicted(e)) out.push({ path: e.path, code: "!" });
    else if (e.y !== " ") out.push({ path: e.path, code: e.y });
  }
  return out;
}

export type Commit = { hash: string; short: string; author: string; email: string; time: number; subject: string };

/** The format `git log` is asked for. */
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

export function parseLog(out: string): Commit[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, short, author, email, time, ...subject] = line.split("\x1f");
      return { hash, short, author, email, time: Number(time), subject: subject.join("\x1f") };
    });
}

/** `git branch --format=%(refname:short)`; tolerates the plain listing's `* ` marker too. */
export function parseBranches(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/^[*+ ]+/, "").trim())
    .filter((l) => l && !l.startsWith("("));
}
