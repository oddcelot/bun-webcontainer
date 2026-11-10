import { createSignal, createStore, reconcile } from "solid-js";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import type { VFS } from "@runbun/vfs";
import { contents, setHeadBaseline, snapshot, type Baseline } from "../changes";
import { git, type GitResult } from "./git";
import { LOG_FORMAT, parseBranches, parseLog, parseStatus, stagedChanges, worktreeChanges, type Commit, type FileChange, type StatusEntry } from "./parse";

/** How long after the last change to the project's files the status is read again. */
const DEBOUNCE = 300;
const VIEW_KEY = "runbun:explorer";

export type ExplorerView = "files" | "git";

const savedView = (): ExplorerView => {
  try {
    return sessionStorage.getItem(VIEW_KEY) === "git" ? "git" : "files";
  } catch {
    return "files";
  }
};

/** Whether a key press is in the commit message box, which Mod+Enter commits from (not Run). */
export const inCommitBox = (e: Event) => e.target instanceof Element && !!e.target.closest("[data-commit-message]");

/** The tree's name for a status letter. */
const TREE_STATUS: Record<string, GitStatus> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified", U: "untracked", "!": "modified" };

/**
 * The Git panel's state over the project's files and `git` (git/git.ts): what the status says, the branches and the
 * last commits, with an action for each thing the panel does. Every action runs git and then reads the state again;
 * so do changes to the files (debounced) and console `git` commands. Nothing runs, and git.wasm isn't fetched, until
 * the feature is on and either the panel was opened or the project already has a repository.
 */
export function createGit(vfs: VFS, opts: { enabled: () => boolean; log: (level: string, text: string) => void; beforeRun: () => void }) {
  const [state, setState] = createStore({
    /** Which one the explorer pane shows. */
    view: savedView(),
    /** The project has a repository (.git/HEAD). */
    repo: false,
    /** The first status is in. */
    loaded: false,
    /** The Git view was opened: its branches and history are read too. */
    panel: savedView() === "git",
    branch: null as string | null,
    /** HEAD has a commit; false right after `git init`. */
    hasHead: false,
    staged: [] as FileChange[],
    changes: [] as FileChange[],
    commits: [] as Commit[],
    branches: [] as string[],
    /** A panel action is running. */
    busy: false,
    /** What git said when the last action failed; the panel shows it until dismissed. */
    error: null as string | null,
  });
  const [statuses, setStatuses] = createSignal<GitStatusEntry[]>([]);
  const enabled = () => opts.enabled();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  /** The last status and HEAD, to tell whether the baseline for the Changes tab moved. */
  let signature = "";

  const run = (args: string[]) => git(vfs, args, { colors: false });

  async function read() {
    const repo = vfs.files.has(".git/HEAD");
    if (!repo) {
      signature = "";
      setHeadBaseline(null);
      setState((s) => {
        s.repo = false;
        s.loaded = true;
        s.branch = null;
        s.hasHead = false;
        s.staged = [];
        s.changes = [];
        s.commits = [];
        s.branches = [];
      });
      setStatuses([]);
      return;
    }
    const st = await run(["status", "--porcelain", "-b", "-z", "-uall"]);
    if (st.exitCode) {
      // Mid-restore or a repository git can't read: say so only where the reader is looking.
      if (state.panel) setState((s) => void (s.error = message(st)));
      return;
    }
    const status = parseStatus(st.stdout);
    const hasHead = !status.unborn;
    let oid = "";
    let commits: Commit[] | undefined;
    let branches: string[] | undefined;
    if (hasHead) oid = (await run(["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim();
    if (state.panel) {
      if (hasHead) {
        const log = await run(["log", `--format=${LOG_FORMAT}`, "-n", "50"]);
        if (!log.exitCode) commits = parseLog(log.stdout);
        const list = await run(["branch", "--format=%(refname:short)"]);
        if (!list.exitCode) branches = parseBranches(list.stdout);
      } else branches = status.branch ? [status.branch] : [];
    }
    const staged = stagedChanges(status.entries);
    const changes = worktreeChanges(status.entries);
    setState((s) => {
      s.repo = true;
      s.loaded = true;
      s.branch = status.branch;
      s.hasHead = hasHead;
      reconcile(staged, "path")(s.staged);
      reconcile(changes, "path")(s.changes);
      if (commits) reconcile(commits, "hash")(s.commits);
      else if (!hasHead) s.commits = [];
      if (branches) s.branches = branches;
    });
    const tree: GitStatusEntry[] = [];
    for (const e of status.entries) tree.push({ path: e.path, status: TREE_STATUS[e.y !== " " && e.x !== "?" ? e.y : e.x] ?? "modified" });
    setStatuses(tree);
    const sig = hasHead ? JSON.stringify([oid, status.entries]) : "";
    if (sig !== signature) {
      signature = sig;
      setHeadBaseline(hasHead ? () => headBaseline(status.entries) : null);
    }
  }

  /** The project's files as the last commit had them: what the Changes tab and its counter compare with. */
  async function headBaseline(entries: StatusEntry[]): Promise<Baseline | null> {
    const base = snapshot(vfs);
    const atHead = async (path: string) => {
      const r = await run(["show", `HEAD:${path}`]);
      if (r.exitCode) return base.delete(path);
      base.set(path, contents(r.bytes));
    };
    for (const e of entries) {
      if (e.x === "?" && e.path.endsWith("/")) {
        for (const p of [...base.keys()]) if (p.startsWith(e.path)) base.delete(p);
      } else if (e.x === "?" || e.x === "A") base.delete(e.path);
      else if (e.x === "R" || e.x === "C") {
        base.delete(e.path);
        if (e.orig) await atHead(e.orig);
      } else await atHead(e.path);
    }
    return base;
  }

  const message = (r: GitResult) => (r.stderr || r.stdout).trim() || `git exited with ${r.exitCode}`;

  /** Reads the status (and, with the panel open, the branches and history) again; calls that overlap run once more after. */
  function refresh(): Promise<void> {
    if (!enabled()) return Promise.resolve();
    if (!state.repo && !state.panel && !vfs.files.has(".git/HEAD")) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await read();
        } while (again);
      } catch (e) {
        opts.log("warn", `[git] ${e}`);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  function schedule(delay = DEBOUNCE) {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), delay);
  }

  vfs.onChange(({ path, created, removed }) => {
    if (/^\.git(\/|$)/.test(path)) {
      // `git init` (or a repository restored): the status, now that there is one. The rest of .git/ changes as git
      // runs, which reads the state itself.
      if (path === ".git/HEAD" && (created || removed)) schedule();
      return;
    }
    if (state.repo || state.panel) schedule();
  });
  vfs.onClear(() => {
    setHeadBaseline(null);
    signature = "";
    schedule(0);
  });

  /** Runs a panel action: git, then the state again; a failure is kept in `error` and in the console. */
  async function act(args: string[] | (() => Promise<GitResult | void>)): Promise<GitResult | undefined> {
    if (!enabled()) return;
    opts.beforeRun();
    setState((s) => {
      s.busy = true;
      s.error = null;
      s.panel = true;
    });
    let result: GitResult | undefined;
    try {
      const out = typeof args === "function" ? await args() : await run(args);
      result = out || undefined;
      if (result?.exitCode) {
        const text = message(result);
        setState((s) => void (s.error = text));
        opts.log("error", `[git] ${text}`);
      }
    } catch (e) {
      setState((s) => void (s.error = String(e)));
      opts.log("error", `[git] ${e}`);
    }
    await refresh();
    setState((s) => void (s.busy = false));
    return result;
  }
  const ok = (r: GitResult | undefined) => !!r && r.exitCode === 0;

  return {
    state,
    enabled,
    /** The tree's git status entries (paths as the tree has them). */
    statuses,
    refresh,
    /** A console `git` command ran: its changes to .git/ and the files are read. */
    commandRan() {
      if (enabled()) schedule(0);
    },
    /** The project was replaced (another project, a folder): the repository it has, if any. */
    projectChanged() {
      schedule(0);
    },
    setView(view: ExplorerView) {
      try {
        sessionStorage.setItem(VIEW_KEY, view);
      } catch {}
      setState((s) => {
        s.view = view;
        if (view === "git") s.panel = true;
      });
      if (view === "git") void refresh();
    },
    dismissError() {
      setState((s) => void (s.error = null));
    },
    init: () => act(["init"]).then(ok),
    stage: (paths: string[]) => act(["add", "--", ...paths]).then(ok),
    stageAll: () => act(["add", "-A"]).then(ok),
    /** Takes paths out of the index; before the first commit there is no HEAD to restore from, so the index entry goes. */
    unstage: (paths: string[]) => act(state.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "-r", "--cached", "-q", "--", ...paths]).then(ok),
    /** Puts tracked files back as the index has them; untracked ones are deleted. */
    discard: (list: FileChange[]) =>
      act(async () => {
        for (const c of list) if (c.code === "U") vfs.remove(c.path.replace(/\/$/, ""));
        const tracked = list.filter((c) => c.code !== "U").map((c) => c.path);
        if (tracked.length) return run(["restore", "--", ...tracked]);
      }).then(ok),
    /** Commits what is staged; `all` stages every change first (VS Code's smart commit). */
    commit: (msg: string, o: { all?: boolean; amend?: boolean } = {}) =>
      act(async () => {
        if (o.all) {
          const added = await run(["add", "-A"]);
          if (added.exitCode) return added;
        }
        return run(["commit", ...(o.amend ? ["--amend"] : []), "-m", msg]);
      }).then(ok),
    undoCommit: () => act(["reset", "--soft", "HEAD~1"]).then(ok),
    switchTo: (branch: string) => act(["switch", branch]).then(ok),
    createBranch: (name: string) => act(["switch", "-c", name]).then(ok),
    /** `force`: `-D`, for a branch whose commits are on no other branch (they're lost). */
    deleteBranch: (name: string, force = false) => act(["branch", force ? "-D" : "-d", name]).then(ok),
    /** What `git show` prints for a commit. */
    async show(hash: string) {
      const r = await run(["show", hash]);
      return r.exitCode ? message(r) : r.stdout;
    },
  };
}

export type Git = ReturnType<typeof createGit>;
