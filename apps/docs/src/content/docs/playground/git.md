---
title: Git
description: "Use git in the playground: the Git view for branches, merges, stashes, commits and history, and which git commands and remotes the console supports."
sidebar:
  order: 3
---

The playground has `git` for the project, in the console and in a **Git view** that takes the file tree's place. The view runs the same `git` as the console, so the two always show one repository.

<details>
<summary>How to open the Git view, and Git in an embed</summary>

The status bar's change counter shows or hides it (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> does the same; the choice is kept for the tab); in an embed, a **Files | Git** switch sits above the tree. The Git view takes the tree's place, like Source Control in VS Code.

In an embed, Git is the `git` feature (the ⋯ menu's Git switch, or `-git` in `features`).

</details>

## The Git view

- **No repository yet:** **Initialize repository** runs `git init`.
- <details>
  <summary><strong>Branch:</strong> the button at the top lists the branches, creates one, merges another into the current branch or deletes one.</summary>

  - The button at the top lists the branches (pick one to switch), creates a branch (**Create branch…**), merges another one into the current branch (**Merge into …**) or deletes another one (one whose commits are on no other branch only after a second **Delete anyway**).
  - A switch git can't make because it would overwrite changed files says so in a box under the branch; the files stay as they were.

  </details>
- <details>
  <summary><strong>Merges and conflicts:</strong> a merge that stops on conflicts lists the files under <strong>Merge Changes</strong>; fix them, mark them resolved and commit the merge.</summary>

  **Merge**

  - A merge (from the branch menu, **Pull**, or `git merge` in the console) that stops on conflicts shows a box with the merge's name and **Abort** (`merge --abort`, asks first), and lists the conflicted files under **Merge Changes**.
  - Open a file, fix the lines between `<<<<<<<` and `>>>>>>>`, then **Mark as resolved** (✓, `git add`; it asks first while the markers are still there).
  - Once none are left, **Commit merge** makes the merge commit, with your message or git's (`Merge branch 'feat'`).

  **Stash and rebase**

  - A stash that conflicts when applied lists its files the same way.
  - A rebase that stops (`git rebase`, or **Pull** with `pull.rebase` set) shows its branch and progress the same way. Once the files are resolved, **Continue rebase** commits that step and replays the rest, **Skip this commit** leaves it out, and **Abort** puts the branch back.

  </details>
- <details>
  <summary><strong>Stashes:</strong> the <strong>⋯</strong> menu's <strong>Stash all changes</strong> sets every change aside, new files too.</summary>

  This is `git stash -u`. **Stashes** lists them; hover one to apply it, pop it (apply and drop) or drop it, or click it to read its changes.

  </details>
- <details>
  <summary><strong>Pull and push:</strong> a branch that tracks a remote has ↓ (<strong>Pull</strong>) and ↑ (<strong>Push</strong>) next to it; one that tracks none has <strong>Publish</strong>.</summary>

  - Each of ↓ and ↑ shows how many commits it would move as of the last fetch.
  - A branch that tracks none has **Publish** instead (`push -u` to `origin`).
  - The **⋯** menu also has **Fetch**.
  - A line under the branch says what's happening while they run, and a push GitHub refuses without an account offers **Sign in with GitHub**.

  </details>
- <details>
  <summary><strong>Commit:</strong> type a message and press <strong>Commit</strong> (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> in the box).</summary>

  With nothing staged the button reads **Commit all** and stages every change first, as VS Code's smart commit does. The **⋯** menu has **Amend last commit** and **Undo last commit** (`reset --soft HEAD~1`: its changes stay staged).

  </details>
- <details>
  <summary><strong>Staged Changes</strong> and <strong>Changes</strong> list each file with its folder and a letter; hover a row to stage, unstage, discard or open it.</summary>

  **Letters**

  Each file shows its folder and a letter (M modified, A added, D deleted, R renamed, U untracked).

  **Renames**

  A staged rename shows as one renamed file, as git pairs them: the same content, or at least half of it; until it is staged, a moved file shows as deleted plus untracked.

  **Row actions**

  - Hover a row to stage (+), unstage (−), discard (↺, asks first; an untracked file is deleted) or open the file; the section headers do the same for all files.
  - Clicking a row opens the **Changes** tab at that file's diff.

  </details>
- **History:** the last 50 commits; click one to read its `git show`.

With a repository that has a commit, the file tree marks changed, added, deleted and untracked files, and the **Changes** tab and the status bar's counter compare the files with the **last commit** instead of the project's source. The view follows your edits, and `git` commands typed in the console.

<details>
<summary>Loading cost and when the repository is read</summary>

Nothing of git loads (about 1.1 MB) until you open the Git view or run a `git` command; a project that already has a `.git/` reads it at once for the tree's marks.

</details>

## How git runs here

`git` runs [gitoxide](https://github.com/GitoxideLabs/gitoxide), a Git written in Rust, compiled to WebAssembly, on the project's files, in a background worker so a command never holds up the editor.

<details>
<summary>Where the repository lives, and what git ignores</summary>

- `git init` makes a repository in `.git/`.
- git never sees `node_modules/` (it isn't committed in practice, and `git init` also lists it in `.git/info/exclude`), and it ignores executable bits, which the browser's files don't have.
- The repository is kept with the project in this browser and survives a reload, but it is not part of share links, downloads or a folder opened from disk, and the file tree doesn't list `.git/`.
- `reset` (the console command) throws it away with your other changes.

</details>

## Supported commands

<details>
<summary>Local commands: <code>init</code>, <code>status</code>, <code>add</code>, <code>commit</code>, <code>log</code>, <code>diff</code>, <code>branch</code>, <code>switch</code>, <code>restore</code>, <code>reset</code> and more</summary>

What works:

- `init`, `status` (`-s`, `-b`, `--porcelain`, `-z`, `-uall`; it says whether your branch is ahead of or behind its upstream, as git does), `add` (paths, `.`, `-A`, `-u`), `rm` (`--cached`), `commit` (`-m`, `-a`, `--amend`, `--allow-empty`), `log` (`--oneline`, `--format`, `-n`, `--all`, `-- <path>`), `diff` (and `--cached`), `show` (a commit, or `<rev>:<path>`), `branch` (list, create, `-d`/`-D`, `-m`).
- `switch` and `checkout` (`-c`/`-b`, `--detach`, paths; leaving a detached HEAD warns about commits no branch keeps, as git does), `restore` (`--staged`, `--source`), `reset` (`--soft`, `--mixed`, `--hard`, paths), `clean`, `config` (this repository's `.git/config`: `git config user.name "Ada"` signs your commits; otherwise they're signed `Playground <playground@runbun.dev>`) and `rev-parse`.
- Like git, `switch` and `checkout` refuse to overwrite changes you haven't committed.
- Paths are files or folders, not globs.

</details>

<details>
<summary><code>merge</code> fast-forwards or makes a merge commit, also of several branches at once, and stops on conflicts as git does</summary>

`merge` (`--no-ff`, `--ff-only`, `-m`, `--abort`, `--no-commit`, `--squash`, `-s ours`, `-X ours`/`-X theirs`, `-X no-renames`, `-X diff-algorithm=histogram`) fast-forwards or makes a merge commit, also of several branches at once (an octopus merge).

Where both branches changed the same lines it stops with conflict markers in the files, as git does: edit them, `git add` the files and `git commit`, or `git merge --abort`.

</details>

<details>
<summary><code>tag</code> lists, creates (lightweight or annotated) and deletes tags, with <code>--sort</code>, <code>--contains</code> and <code>--format</code></summary>

`tag` lists (`-l <pattern>`, `-n`, `-i`, `--sort`, e.g. `--sort=-v:refname`, which puts `v1.0-rc1` before `v1.0` once `git config versionsort.suffix -rc` is set, `--contains`, `--merged`, `--points-at` and `--format`, e.g. `--format='%(refname:short) %(subject)'`, with `%(align)` and `%(if)…%(then)…%(else)…%(end)`), creates (lightweight, or annotated with `-a`, `-m` or `-F <file>`; not signed) and deletes (`-d`) tags.

</details>

<details>
<summary><code>stash</code> sets your changes aside and brings them back, with <code>-u</code>, <code>pop</code>, <code>apply</code>, <code>list</code> and more</summary>

`stash` (`-m`, `-u`, `-a`, `-k`, `--staged`, paths after `--`, `list`, `show`, `apply`, `pop`, `drop`, `clear`, `branch`, `create`, `store`; not `--patch`, which asks hunk by hunk) sets your changes aside and brings them back; a stash conflicts like a merge does.

</details>

<details>
<summary><code>rebase</code> replays your branch's commits onto another one, with <code>--onto</code>, <code>--autostash</code>, <code>--continue</code>, <code>--skip</code> and <code>--abort</code></summary>

`rebase` (`--onto`, `-X ours`/`-X theirs`, `--autostash` or `git config rebase.autoStash true` to set your uncommitted changes aside and bring them back after, `--continue`, `--skip`, `--abort`, `--quit`) replays your branch's commits onto another one (or another branch's: `git rebase main feat`), leaving out those it already has.

- With no upstream named, it rebases onto the branch's upstream from where your branch forked from it, as git's `--fork-point` does, so commits a force-push removed upstream stay removed.
- A conflict stops it with markers in the files, as git does: fix them, `git add` and `git rebase --continue` (a `git commit` without `-m` in between takes the stopped commit's message; the Git view shows the rebase with **Continue rebase**, **Skip this commit** and **Abort**).
- Not `rebase -i`, `--exec` or `--rebase-merges`.

</details>

<details>
<summary>Remotes on GitHub, GitLab, Codeberg and Bitbucket: <code>remote</code>, <code>fetch</code>, <code>pull</code>, <code>clone</code> and <code>push</code></summary>

With remotes on GitHub, GitLab, Codeberg or Bitbucket (`https://` URLs):

- `remote` (`-v`, `add`, `remove`, `get-url`, `set-url`), `fetch` (`--depth`).
- `pull` (fetches and merges, as git's `pull.rebase=false` does, or fast-forwards; `--ff-only`, `--no-ff`; `--rebase`, or `git config pull.rebase true`, rebases your commits onto the fetched ones instead).
- `clone` (`--depth`, `-b`) into an empty project (or **With Git history** in the gallery, which makes one).
- `push` (`-u`, `-f`, `-d`, `<src>:<dst>`; refused when the remote has commits you don't, unless forced), also from the Git view's pull and push buttons.

Private GitHub repositories and pushing to GitHub work once you sign in with GitHub (the Git view's ⋯ menu, or **Clone a repository**, which then lists your repositories; see [Privacy](/privacy/#sign-in-with-github)) and grant runbun.dev the repository; other hosts are public and read-only.

Git hosts don't let a browser page talk to them directly, so these requests go through runbun.dev's git proxy, which passes them on unchanged and keeps nothing (see [Privacy](/privacy/)).

</details>
