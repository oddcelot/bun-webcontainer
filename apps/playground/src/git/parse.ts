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
  /** Commits the branch has that its upstream hasn't, and the other way round. */
  ahead: number;
  behind: number;
  /** The upstream is configured but its ref is missing (deleted on the remote, or never fetched). */
  gone: boolean;
  entries: StatusEntry[];
};

/** `git status --porcelain -b -z` (v1). Untracked directories end with `/` unless `-uall` listed their files. */
export function parseStatus(out: string): Status {
  const parts = out.split("\0");
  const status: Status = { branch: null, unborn: false, ahead: 0, behind: 0, gone: false, entries: [] };
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
        const [, branch, upstream, track = ""] = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head)!;
        status.branch = branch;
        status.upstream = upstream;
        status.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
        status.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
        status.gone = track === "gone";
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
  /** A conflicted path's `XY` (`UU`, `AA`, `UD`, …), see CONFLICT_KINDS. */
  conflict?: string;
};

const conflicted = (e: StatusEntry) => e.x === "U" || e.y === "U" || (e.x === "A" && e.y === "A") || (e.x === "D" && e.y === "D");

/** What is staged: the index column of each entry. */
export function stagedChanges(entries: StatusEntry[]): FileChange[] {
  return entries
    .filter((e) => e.x !== " " && e.x !== "?" && e.x !== "!" && !conflicted(e))
    .map((e) => ({ path: e.path, orig: e.orig, code: e.x }));
}

/** What is not staged: the worktree column and untracked files (conflicts are conflictedChanges'). */
export function worktreeChanges(entries: StatusEntry[]): FileChange[] {
  const out: FileChange[] = [];
  for (const e of entries) {
    if (e.x === "!" || conflicted(e)) continue;
    if (e.x === "?") out.push({ path: e.path, code: "U", dir: e.path.endsWith("/") });
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

/** What each side did to a conflicted path, by its `XY` in `git status`. */
export const CONFLICT_KINDS: Record<string, string> = {
  UU: "both modified",
  AA: "both added",
  DD: "both deleted",
  AU: "added by us",
  UA: "added by them",
  DU: "deleted by us",
  UD: "deleted by them",
};

/** The paths a merge (or a stash applied) left conflicted, for the Merge Changes section. */
export function conflictedChanges(entries: StatusEntry[]): FileChange[] {
  return entries.filter(conflicted).map((e) => ({ path: e.path, code: "!", conflict: e.x + e.y }));
}

/** A merge's title from `.git/MERGE_MSG` (`Merge branch 'feat'`): its first line that isn't a comment. */
export function mergeTitle(msg: string): string {
  return msg.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
}

export type Stash = {
  /** n in `stash@{n}`, newest first. */
  index: number;
  /** As stored: `On main: wip`, `WIP on main: abc1234 subject`. */
  message: string;
  /** What the list shows: the message given to `stash -m`, else git's `WIP on main: abc1234 subject`. */
  label: string;
  /** The branch it was made on (`(no branch)` when detached). */
  branch: string;
};

/** `git stash list`: `stash@{0}: On main: message` lines. */
export function parseStashes(out: string): Stash[] {
  const list: Stash[] = [];
  for (const line of out.split("\n")) {
    const m = /^stash@\{(\d+)\}: (.*)$/.exec(line);
    if (!m) continue;
    const message = m[2];
    const on = /^On ([^:]+): (.*)$/.exec(message);
    const wip = /^WIP on ([^:]+): /.exec(message);
    list.push({ index: Number(m[1]), message, label: on ? on[2] : message, branch: (on ?? wip)?.[1] ?? "" });
  }
  return list;
}
