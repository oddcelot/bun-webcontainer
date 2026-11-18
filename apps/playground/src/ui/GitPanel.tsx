import { For, Show, createSignal, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@runbun/ui/solid/Button";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Input } from "@runbun/ui/solid/Input";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Tip } from "@runbun/ui/solid/Tip";
import { isMac } from "../keymap";
import { CONFLICT_KINDS, type Commit, type FileChange, type Stash } from "../git/parse";
import { askRepo } from "./ProjectPicker";
import { account, loadAccount, signIn, signInAvailable, signOut } from "../account";
import { AppContext } from "./context";
import { PromptDialog } from "./PromptDialog";

const CODES: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Untracked", "!": "Conflict" };

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
/** "3 hr. ago", "yesterday": when a commit was made. */
function ago(seconds: number): string {
  const diff = seconds - Date.now() / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(diff) >= size) return RELATIVE.format(Math.round(diff / size), unit);
  return "just now";
}

/** The file's name, then the folders it is in. */
function split(path: string): [name: string, dir: string] {
  const parts = path.replace(/\/$/, "").split("/");
  const name = parts.pop() ?? path;
  return [name + (path.endsWith("/") ? "/" : ""), parts.join("/")];
}

/** A dialog from a menu item opens a moment after the menu closes: the menu's focus return would take the focus the dialog just moved. */
const later = (fn: () => void) => void setTimeout(fn, 50);

/** Text that may wrap after each `/` too (a branch's `feature/name`), not only at spaces and hyphens. */
const breakable = (text: string) => text.split(/(?<=\/)/).flatMap((part, i) => (i ? [<wbr />, part] : [part]));

type Ask = { title: string; body: string; label: string; run(): void };

/** A small icon button with a tooltip, for the rows' and sections' actions. */
function Act(props: { icon: string; tip: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tip class="git-act" tip={props.tip} aria-label={props.tip} disabled={props.disabled} onClick={props.onClick}>
      <i class={props.icon} aria-hidden="true" />
    </Tip>
  );
}

function Section(props: { title: string; count: number; open: boolean; onToggle: () => void; actions?: JSX.Element; children?: JSX.Element }) {
  return (
    <section class="git-section">
      <header>
        <button type="button" class="git-toggle" aria-expanded={props.open ? "true" : "false"} onClick={props.onToggle}>
          <i class="i-lucide-chevron-right" aria-hidden="true" />
          <span class="title">{props.title}</span>
          <span class="count">{props.count}</span>
        </button>
        <span class="git-acts">{props.actions}</span>
      </header>
      <Show when={props.open}>
        <ul>{props.children}</ul>
      </Show>
    </section>
  );
}

/**
 * The Git view of the explorer pane, as in VS Code's Source Control: the branch, a commit box, the staged and the
 * other changes (a click on a file shows its diff in the Changes tab), and the last commits. Everything it does is a
 * `git` command (git/store.ts), so the console shows the same repository.
 */
export function GitPanel() {
  const app = useContext(AppContext);
  const { git, workspace: ws } = app;
  // Signed in with GitHub (the playground's; an embed can't have runbun.dev's cookies): for the menu below.
  if (!app.features) void loadAccount();
  const s = git.state;
  const [message, setMessage] = createSignal("");
  const [amending, setAmending] = createSignal(false);
  const [open, setOpen] = createSignal({ conflicts: true, staged: true, changes: true, stashes: true, history: true });
  const toggle = (k: keyof ReturnType<typeof open>) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [ask, setAsk] = createSignal<Ask | null>(null);
  // git refuses `-d` for a branch whose commits are on no other branch: ask again before `-D` loses them.
  const deleteBranch = (b: string) =>
    void git.deleteBranch(b).then((deleted) => {
      if (deleted || !git.state.error?.includes("not fully merged")) return;
      setAsk({ title: `Delete ${b} anyway?`, body: "Its commits are on no other branch and will be lost.", label: "Delete anyway", run: () => void git.deleteBranch(b, true) });
    });
  const [naming, setNaming] = createSignal(false);
  /** A commit's `git show`, or a stash's `git stash show -p`, in a dialog. */
  const [showing, setShowing] = createSignal<{ title: string; description: string; text: string } | null>(null);
  let branchButton: HTMLButtonElement | undefined;

  const paths = (list: FileChange[]) => list.flatMap((c) => (c.orig ? [c.path, c.orig] : [c.path]));
  // During a merge the box may stay empty (git's prepared message is used), and only once nothing is conflicted; a
  // rebase's step keeps its commit's message.
  const canCommit = () =>
    s.merging || s.rebasing ? !s.conflicts.length : !!message().trim() && (amending() ? s.hasHead : s.staged.length > 0 || s.changes.length > 0);
  const label = () => (s.rebasing ? "Continue rebase" : s.merging ? "Commit merge" : amending() ? "Amend" : s.staged.length ? "Commit" : "Commit all");
  const commitTip = () =>
    s.merging || s.rebasing
      ? s.conflicts.length
        ? "Resolve the conflicts first"
        : s.rebasing
          ? "Commit this step and replay the remaining commits"
          : "Commit the merge"
      : amending()
        ? "Amend the last commit"
        : s.staged.length
          ? "Commit the staged changes"
          : "Stage everything and commit";

  async function commit() {
    if (!canCommit() || s.busy) return;
    if (s.rebasing) {
      await git.continueRebase();
      return;
    }
    if (s.merging) {
      if (await git.commitMerge(message().trim())) setMessage("");
      return;
    }
    if (await git.commit(message().trim(), { amend: amending(), all: !amending() && !s.staged.length })) {
      setMessage("");
      setAmending(false);
    }
  }
  function startAmend() {
    setAmending(true);
    if (!message().trim() && s.commits[0]) setMessage(s.commits[0].subject);
  }
  function undoCommit() {
    const last = s.commits[0];
    setAsk({
      title: "Undo the last commit?",
      body: `${last ? `Undoes "${last.subject}".` : "Undoes the commit."} The changes stay staged and the message returns to the box.`,
      label: "Undo commit",
      run: () =>
        void git.undoCommit().then((ok) => {
          if (ok && last && !message().trim()) setMessage(last.subject);
        }),
    });
  }
  function discard(list: FileChange[], all = false) {
    const untracked = list.filter((c) => c.code === "U").length;
    const one = list[0];
    setAsk({
      title: all ? `Discard all ${list.length} changes?` : `Discard changes to ${split(one.path)[0]}?`,
      body: `${all ? "Resets the files to the staged version." : untracked ? "Deletes the untracked file." : "Resets the file to the staged version."}${
        all && untracked ? ` ${untracked} untracked ${untracked === 1 ? "file is" : "files are"} deleted.` : ""
      } This can't be undone.`,
      label: "Discard",
      run: () => void git.discard(list),
    });
  }
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  // A remote answered 401/403: GitHub wants the signed-in user's token (git/http.ts adds it through the proxy).
  const wantsSignIn = () => !app.features && signInAvailable() && account() === null && /HTTP 40[13]|authentication required|access denied|[Ss]ign in with GitHub/.test(s.error ?? "");
  const pushTip = () => (s.ahead ? `Push ${plural(s.ahead, "commit")} to ${s.upstream}` : `Push to ${s.upstream}`);
  const pullTip = () => (s.behind ? `Pull ${plural(s.behind, "commit")} from ${s.upstream}` : `Pull from ${s.upstream}`);

  async function showCommit(commit: Commit) {
    const head = { title: commit.subject, description: `${commit.short} by ${commit.author}, ${ago(commit.time)}` };
    setShowing({ ...head, text: "Reading the commit…" });
    setShowing({ ...head, text: await git.show(commit.hash) });
  }
  async function showStash(st: Stash) {
    const head = { title: st.label, description: `stash@{${st.index}}${st.branch ? `, made on ${st.branch}` : ""}` };
    setShowing({ ...head, text: "Reading the stash…" });
    setShowing({ ...head, text: await git.showStash(st.index) });
  }
  // Marking a file resolved that still has conflict markers is likely a slip: ask first.
  function resolve(list: FileChange[]) {
    const marked = list.filter((c) => git.hasMarkers(c.path));
    if (!marked.length) return void git.resolve(list.map((c) => c.path));
    setAsk({
      title: marked.length === 1 ? `${split(marked[0].path)[0]} still has conflict markers` : `${marked.length} files still have conflict markers`,
      body: "Lines between <<<<<<< and >>>>>>> are both sides of a conflict. Mark as resolved anyway? The markers are committed as they are.",
      label: "Mark as resolved",
      run: () => void git.resolve(list.map((c) => c.path)),
    });
  }
  function abortMerge() {
    setAsk({
      title: "Abort the merge?",
      body: "Puts the files the merge changed back as they were before it, your edits to them included. Other changes stay.",
      label: "Abort merge",
      run: () => void git.abortMerge(),
    });
  }
  function abortRebase() {
    setAsk({
      title: "Abort the rebase?",
      body: "Puts the branch and its files back as they were before the rebase. The commits replayed so far are dropped.",
      label: "Abort rebase",
      run: () => void git.abortRebase(),
    });
  }
  function dropStash(st: Stash) {
    setAsk({ title: `Drop ${st.label}?`, body: `Deletes stash@{${st.index}} and the changes in it. This can't be undone.`, label: "Drop stash", run: () => void git.dropStash(st.index) });
  }
  const conflictTitle = (c: FileChange) => `${c.path} (conflict: ${CONFLICT_KINDS[c.conflict ?? ""] ?? c.conflict})`;

  const Row = (props: { c: FileChange; staged: boolean }) => {
    const parts = () => split(props.c.path);
    return (
      <li class="git-row">
        <button type="button" class="git-file" title={`${props.c.path} (${CODES[props.c.code] ?? props.c.code})`} onClick={() => ws.showChange(props.c.path)}>
          <span class="name">{parts()[0]}</span>
          <Show when={parts()[1]}>
            <span class="dir">{parts()[1]}</span>
          </Show>
        </button>
        <span class="git-acts">
          <Show when={props.c.code !== "D" && !props.c.dir}>
            <Act icon="i-lucide-file-pen-line" tip="Open the file" onClick={() => ws.open(props.c.path)} />
          </Show>
          <Show
            when={props.staged}
            fallback={
              <>
                <Show when={props.c.code !== "!"}>
                  <Act icon="i-lucide-undo-2" tip="Discard the changes" onClick={() => discard([props.c])} />
                </Show>
                <Act icon="i-lucide-plus" tip="Stage the changes" onClick={() => void git.stage([props.c.path])} />
              </>
            }
          >
            <Act icon="i-lucide-minus" tip="Unstage the changes" onClick={() => void git.unstage(paths([props.c]))} />
          </Show>
        </span>
        <span class="code" data-code={props.c.code} aria-label={CODES[props.c.code]}>
          {props.c.code}
        </span>
      </li>
    );
  };

  return (
    <div class="git-panel">
      <Show when={s.repo} fallback={<Start />}>
        <div class="git-head">
          <Menu
            placement="bottom-start"
            trigger={
              <Tip as={MenuTrigger} class="git-branch" tip="Switch or create a branch" ref={(el: HTMLButtonElement) => (branchButton = el)}>
                <i class="i-lucide-git-branch" aria-hidden="true" />
                <span class="name">{s.branch ?? "detached HEAD"}</span>
                <i class="i-lucide-chevron-down" aria-hidden="true" />
              </Tip>
            }
          >
            <MenuGroup label="Switch to">
              <For each={s.branches}>
                {(b) => <MenuItem icon={b === s.branch ? "i-lucide-check" : "i-lucide-git-branch"} label={b} disabled={b === s.branch || !s.hasHead} onSelect={() => void git.switchTo(b)} />}
              </For>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem icon="i-lucide-plus" label="Create branch…" disabled={!s.hasHead} onSelect={() => later(() => setNaming(true))} />
            <Show when={s.hasHead && s.branches.some((b) => b !== s.branch)}>
              <MenuSeparator />
              <MenuGroup label={`Merge into ${s.branch ?? "HEAD"}`}>
                <For each={s.branches.filter((b) => b !== s.branch)}>
                  {(b) => <MenuItem icon="i-lucide-git-merge" label={b} disabled={s.busy || !!s.merging || !!s.rebasing || s.conflicts.length > 0} onSelect={() => void git.merge(b)} />}
                </For>
              </MenuGroup>
            </Show>
            <Show when={s.branches.some((b) => b !== s.branch)}>
              <MenuSeparator />
              <MenuGroup label="Delete branch">
                <For each={s.branches.filter((b) => b !== s.branch)}>
                  {(b) => (
                    <MenuItem
                      icon="i-lucide-trash-2"
                      label={b}
                      onSelect={() =>
                        later(() => setAsk({ title: `Delete ${b}?`, body: "Deletes the branch. Fails if it has unmerged commits.", label: "Delete", run: () => void deleteBranch(b) }))
                      }
                    />
                  )}
                </For>
              </MenuGroup>
            </Show>
          </Menu>
          <Show
            when={s.upstream && !s.gone}
            fallback={
              <Show when={s.branch && s.hasHead && git.pushRemote()}>
                {(remote) => (
                  <Tip
                    class="git-act git-count"
                    tip={`Publish ${s.branch} to ${remote()}`}
                    aria-label={`Publish ${s.branch} to ${remote()}`}
                    disabled={s.busy}
                    onClick={() => void git.push()}
                  >
                    <i class="i-lucide-cloud-upload" aria-hidden="true" />
                  </Tip>
                )}
              </Show>
            }
          >
            <Tip class="git-act git-count" tip={pullTip()} aria-label={pullTip()} disabled={s.busy} onClick={() => void git.pull()}>
              <i class="i-lucide-arrow-down" aria-hidden="true" />
              <Show when={s.behind}>
                <span>{s.behind}</span>
              </Show>
            </Tip>
            <Tip class="git-act git-count" tip={pushTip()} aria-label={pushTip()} disabled={s.busy} onClick={() => void git.push()}>
              <i class="i-lucide-arrow-up" aria-hidden="true" />
              <Show when={s.ahead}>
                <span>{s.ahead}</span>
              </Show>
            </Tip>
          </Show>
          <Act icon="i-lucide-refresh-cw" tip="Refresh" onClick={() => void git.refresh()} />
        </div>
        <Show when={s.syncing}>
          {(kind) => (
            <p class="git-progress" role="status">
              <i class="i-lucide-loader-circle" aria-hidden="true" />
              {s.progress || { fetch: "Fetching…", pull: "Pulling…", push: "Pushing…" }[kind()]}
            </p>
          )}
        </Show>
        <Show when={s.error}>
          {(error) => (
            <div class="git-error" role="alert">
              <div class="body">
                <pre>{error()}</pre>
                <Show when={wantsSignIn()}>
                  <Button onClick={() => void signIn()}>Sign in with GitHub</Button>
                </Show>
              </div>
              <Act icon="i-lucide-x" tip="Dismiss" onClick={() => git.dismissError()} />
            </div>
          )}
        </Show>
        <Show when={s.merging || s.rebasing || s.conflicts.length}>
          <div class="git-merge" role="status">
            <div class="top">
              <i class={s.rebasing ? "i-lucide-git-pull-request-arrow" : "i-lucide-git-merge"} aria-hidden="true" />
              <strong>{breakable(s.rebasing ?? s.merging ?? "Applying a stash")}</strong>
              <Show when={s.merging || s.rebasing}>
                <Button disabled={s.busy} onClick={() => (s.rebasing ? abortRebase() : abortMerge())}>
                  Abort
                </Button>
              </Show>
            </div>
            <p>
              {s.conflicts.length
                ? `${plural(s.conflicts.length, "conflicted file")}: edit, then mark resolved.`
                : s.rebasing
                  ? "Conflicts resolved: continue the rebase."
                  : s.merging
                    ? "Conflicts resolved: commit the merge."
                    : "Conflicts resolved."}
            </p>
            <Show when={s.rebasing}>
              <button type="button" class="git-skip" disabled={s.busy} onClick={() => void git.skipRebase()}>
                Skip this commit
              </button>
            </Show>
          </div>
        </Show>
        <div class="git-commit">
          <Input
            multiline
            class="git-message"
            data-commit-message=""
            rows={3}
            aria-label="Commit message"
            placeholder={
              s.rebasing
                ? `The commit keeps its message (${isMac ? "⌘" : "Ctrl+"}Enter to continue)`
                : s.merging
                  ? `${s.merging} (${isMac ? "⌘" : "Ctrl+"}Enter to commit)`
                  : `Message (${isMac ? "⌘" : "Ctrl+"}Enter to commit)`
            }
            disabled={!!s.rebasing}
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <div class="git-commit-row">
            <Tip class="button primary git-do" tip={commitTip()} disabled={!canCommit() || s.busy} onClick={() => void commit()}>
              <i class="i-lucide-check" aria-hidden="true" />
              {label()}
            </Tip>
            <Menu
              placement="bottom-end"
              trigger={
                <Tip as={MenuTrigger} class="button git-more" tip="More actions" aria-label="More actions">
                  <i class="i-lucide-ellipsis" aria-hidden="true" />
                </Tip>
              }
            >
              <MenuItem icon="i-lucide-pencil" label={amending() ? "Amending the last commit" : "Amend last commit"} disabled={!s.hasHead || amending()} onSelect={startAmend} />
              <MenuItem icon="i-lucide-undo-2" label="Undo last commit…" disabled={!s.hasHead || !!s.merging || !!s.rebasing} onSelect={() => later(undoCommit)} />
              <MenuSeparator />
              <MenuItem
                icon="i-lucide-archive"
                label="Stash all changes"
                disabled={s.busy || !s.hasHead || !!s.merging || !!s.rebasing || s.conflicts.length > 0 || !(s.staged.length || s.changes.length)}
                onSelect={() => void git.stash()}
              />
              <Show when={s.remotes.length}>
                <MenuSeparator />
                <MenuItem icon="i-lucide-refresh-ccw" label="Fetch" disabled={s.busy} onSelect={() => void git.fetch()} />
                <MenuItem icon="i-lucide-arrow-down" label="Pull" disabled={s.busy || !s.upstream || s.gone} onSelect={() => void git.pull()} />
                <MenuItem icon="i-lucide-arrow-up" label={s.upstream && !s.gone ? "Push" : "Publish branch"} disabled={s.busy || !s.hasHead || (!(s.upstream && !s.gone) && !git.pushRemote())} onSelect={() => void git.push()} />
              </Show>
              <Show when={!app.features && signInAvailable() && account() !== undefined}>
                <MenuSeparator />
                <Show
                  when={account()}
                  fallback={<MenuItem icon="i-lucide-github" label="Sign in with GitHub…" onSelect={() => void signIn()} />}
                >
                  {(a) => <MenuItem icon="i-lucide-log-out" label={`Sign out of GitHub (${a().name})`} onSelect={() => void signOut()} />}
                </Show>
              </Show>
            </Menu>
          </div>
          <Show when={amending()}>
            <button type="button" class="git-amending" onClick={() => setAmending(false)}>
              Stop amending
            </button>
          </Show>
        </div>
        <div class="git-scroll">
          <Show when={s.conflicts.length}>
            <Section
              title="Merge Changes"
              count={s.conflicts.length}
              open={open().conflicts}
              onToggle={() => toggle("conflicts")}
              actions={<Act icon="i-lucide-check-check" tip="Mark all as resolved" onClick={() => resolve(s.conflicts)} />}
            >
              <For each={s.conflicts}>
                {(c) => (
                  <li class="git-row">
                    <button type="button" class="git-file" title={conflictTitle(c)} onClick={() => ws.showChange(c.path)}>
                      <span class="name">{split(c.path)[0]}</span>
                      <Show when={split(c.path)[1]}>
                        <span class="dir">{split(c.path)[1]}</span>
                      </Show>
                    </button>
                    <span class="git-acts">
                      <Show when={c.conflict !== "DD"}>
                        <Act icon="i-lucide-file-pen-line" tip="Open the file" onClick={() => ws.open(c.path)} />
                      </Show>
                      <Act icon="i-lucide-check" tip="Mark as resolved" onClick={() => resolve([c])} />
                    </span>
                    <span class="code" data-code="!" aria-label={`Conflict: ${CONFLICT_KINDS[c.conflict ?? ""] ?? ""}`}>
                      !
                    </span>
                  </li>
                )}
              </For>
            </Section>
          </Show>
          <Show when={s.staged.length}>
            <Section
              title="Staged Changes"
              count={s.staged.length}
              open={open().staged}
              onToggle={() => toggle("staged")}
              actions={<Act icon="i-lucide-minus" tip="Unstage all" onClick={() => void git.unstage(paths(s.staged))} />}
            >
              <For each={s.staged}>{(c) => <Row c={c} staged />}</For>
            </Section>
          </Show>
          <Section
            title="Changes"
            count={s.changes.length}
            open={open().changes}
            onToggle={() => toggle("changes")}
            actions={
              <>
                <Show when={s.changes.length || s.staged.length}>
                  <Act icon="i-lucide-git-compare" tip="Show all changes" onClick={() => ws.showChanges()} />
                </Show>
                <Show when={s.changes.length}>
                  <Act icon="i-lucide-undo-2" tip="Discard all changes" onClick={() => discard(s.changes.filter((c) => c.code !== "!"), true)} />
                  <Act icon="i-lucide-plus" tip="Stage all changes" onClick={() => void git.stageAll()} />
                </Show>
              </>
            }
          >
            <For each={s.changes} fallback={<li class="git-none">{s.staged.length ? "Nothing else changed." : "No changes."}</li>}>
              {(c) => <Row c={c} staged={false} />}
            </For>
          </Section>
          <Show when={s.stashes.length}>
            <Section title="Stashes" count={s.stashes.length} open={open().stashes} onToggle={() => toggle("stashes")}>
              <For each={s.stashes}>
                {(st) => (
                  <li class="git-row">
                    <button type="button" class="git-commit-item" title={`stash@{${st.index}}: ${st.message}`} onClick={() => void showStash(st)}>
                      <span class="subject">{st.label}</span>
                      <span class="meta">
                        <code>stash@{`{${st.index}}`}</code>
                        <Show when={st.branch}> on {st.branch}</Show>
                      </span>
                    </button>
                    <span class="git-acts">
                      <Act icon="i-lucide-archive-restore" tip="Apply (keep the stash)" disabled={s.busy} onClick={() => void git.applyStash(st.index)} />
                      <Act icon="i-lucide-package-open" tip="Pop (apply and drop)" disabled={s.busy} onClick={() => void git.popStash(st.index)} />
                      <Act icon="i-lucide-trash-2" tip="Drop the stash" disabled={s.busy} onClick={() => dropStash(st)} />
                    </span>
                  </li>
                )}
              </For>
            </Section>
          </Show>
          <Section title="History" count={s.commits.length} open={open().history} onToggle={() => toggle("history")}>
            <For each={s.commits} fallback={<li class="git-none">No commits yet.</li>}>
              {(c) => (
                <li class="git-row">
                  <button type="button" class="git-commit-item" title={`${c.subject}\n${c.author} <${c.email}>`} onClick={() => void showCommit(c)}>
                    <span class="subject">{c.subject}</span>
                    <span class="meta">
                      <code>{c.short}</code> {c.author}, {ago(c.time)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </Section>
        </div>
      </Show>
      <PromptDialog
        open={naming()}
        onOpenChange={setNaming}
        title="Create branch"
        description="Starts at the current commit."
        label="Branch name"
        initial=""
        submit="Create"
        onSubmit={(name) => void git.createBranch(name)}
        returnFocus={() => branchButton}
      />
      <Dialog open={ask() !== null} onOpenChange={(o) => o || setAsk(null)}>
        <Show when={ask()}>
          {(a) => (
            <>
              <DialogTitle>{a().title}</DialogTitle>
              <DialogDescription>{a().body}</DialogDescription>
              <DialogActions>
                <DialogClose>Cancel</DialogClose>
                <Button
                  primary
                  onClick={() => {
                    const { run } = a();
                    setAsk(null);
                    run();
                  }}
                >
                  {a().label}
                </Button>
              </DialogActions>
            </>
          )}
        </Show>
      </Dialog>
      <Dialog class="git-show" open={showing() !== null} onOpenChange={(o) => o || setShowing(null)}>
        <Show when={showing()}>
          {(c) => (
            <>
              <DialogTitle>{c().title}</DialogTitle>
              <DialogDescription>{c().description}</DialogDescription>
              <pre class="git-show-text" tabindex="0">
                {c().text}
              </pre>
              <DialogActions>
                <DialogClose>Close</DialogClose>
              </DialogActions>
            </>
          )}
        </Show>
      </Dialog>
    </div>
  );
}

/** No repository yet: what the panel does, and the button that makes one. */
function Start() {
  const app = useContext(AppContext);
  const { git, workspace: ws } = app;
  return (
    <div class="git-start">
      <Show when={git.state.loaded} fallback={<p>Reading the repository…</p>}>
        <p>This project has no Git repository. Create one to commit, branch and compare changes.</p>
        <Button primary disabled={git.state.busy} onClick={() => void git.init()}>
          <i class="i-lucide-git-branch" aria-hidden="true" /> Initialize repository
        </Button>
        <p class="hint">Stored in this browser only. Not included in share links or zips.</p>
        {/* The playground's gallery opens it (an embed has no gallery, nor `features` unset). */}
        <Show when={!app.features}>
          <Button onClick={() => askRepo("git")}>
            <i class="i-lucide-download" aria-hidden="true" /> Clone a repository…
          </Button>
        </Show>
        <button type="button" class="git-link" onClick={() => ws.showChanges()}>
          <i class="i-lucide-git-compare" aria-hidden="true" /> Compare with the project's source
        </button>
      </Show>
    </div>
  );
}
