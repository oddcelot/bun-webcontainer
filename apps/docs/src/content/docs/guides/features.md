---
title: Features
description: "A tour of the runbun.dev playground: the editor with TypeScript completions, the console, running code, the Bun.serve preview, package installs, projects and share links."
head:
  # The browser tab and search result title; the page heading stays `title`.
  - tag: title
    content: "Bun playground features: editor, console, preview, sharing | Run Bun"
sidebar:
  order: 2
---

## Editor and files

- Syntax-highlighted editor with themes and light/dark mode. CSS in a `css` tagged template and HTML in an `html` one (Lit, styled-components) are highlighted as CSS and HTML, and the CSS gets hovers, completions and warnings (an unknown property, an empty rule) as in a stylesheet. Each file keeps its undo history while the page is open: switching tabs and back, or renaming the file, doesn't lose it. A file changed outside the editor (by your program, or in an opened folder by another editor) starts a fresh history.
- File tree with search and a "New file" button. Right-click a file or folder (or use its ⋯ button) to **rename** or **delete** it, or to add a file to a folder. <kbd>F2</kbd> renames the focused row in place; <kbd>Delete</kbd> (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Backspace</kbd>) deletes it after asking. Open tabs follow a rename and close when their file is deleted; with Watch on, either restarts the program. For ten seconds after, **Undo** under the tree (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> in the tree) brings a deleted file or folder back, tabs included, or moves a renamed one back. In an opened folder, both reach the folder on disk.
- Tabs for open files: close with the × button, <kbd>Delete</kbd>, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>
- **Auto-save** (on by default): edits are saved a moment after you stop typing. Switch it off with the save icon next to Run (in an embed, the tab bar's Auto-save switch) to save with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> instead; unsaved tabs show a dot, and Run, Install, `bun test` and Share save everything first. The setting applies to every project and every open playground tab.
- **Format** (top right of the code while the pointer is over it, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) formats the open file with `bun fmt`, as one undoable edit (see [Toolchain](/compatibility/toolchain/#formatter-bun-fmt))
- Type errors in TypeScript files, a name's type and documentation when the pointer rests on it, and **completions** as you type, from TypeScript 7's checker (see [Toolchain](/compatibility/toolchain/#type-checking)). The list opens after `.`, in import paths, and at the first letter of a name; <kbd>↑</kbd>/<kbd>↓</kbd> pick, <kbd>Enter</kbd> or <kbd>Tab</kbd> insert, <kbd>Esc</kbd> closes it. The selected entry's type and docs show under the list. Names exported by the project's other files, installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) are offered too, with the module they come from, and inserting one adds its import. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click a name (or press <kbd>F12</kbd>) to **go to its definition**, in another file too, or in TypeScript's and Bun's own types (`lib.es5.d.ts`, `bun-types`), which open read-only in a tab with a lock. Typing `(` or `,` in a call shows its **parameter hints** above the line, with the current parameter underlined; <kbd>↑</kbd>/<kbd>↓</kbd> step through overloads and <kbd>Esc</kbd> hides them.
- **Changes:** once the project has a Git commit, this compares with the last commit instead (see [Git](#git)). The counter in the status bar shows how many files differ from the project's source (the demo, the example, the shared link, the GitHub repo, or the folder or zip as opened); it opens the Git view (in an embed with Git off, the tab itself), whose **Show all changes** (or, without a repository, **Compare with the project's source**) opens a **Changes** tab with a diff of each one: modified, added and deleted files, updated as you save. **Open** in a file's header edits it. After a reload the comparison still goes back to the source, not to the restored copy; for a GitHub repo the files are fetched again when the tab first opens. `node_modules` and `.git` aren't compared, and binary files are listed without a diff.
- Resizable panes
- **Run status** as a pill in the status bar (default) or a toast over the panes that fades a few seconds after the program settles; errors stay until the next change. Pick one under **Appearance**.
- **Status bar** along the bottom: buttons to show or hide the file tree, the preview, the console and the [debugger](#debugger) (with both of those hidden, the editor takes their room), what the program is doing and the port it serves (`:3000`; click to show the preview when it's hidden; with several, `:3000 +1` opens a list of them that picks the one the preview shows), and for the open file its error and warning counts (click to go to the next one), the cursor's line and column, and its language (for TypeScript, with the version the type checker follows). Then **format on save** (the wand: saving with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> runs `bun fmt` on the file first; saves as you type don't, and a file `bun fmt` can't format saves as it is), whether the dependencies are installed (how many; **Not installed** installs them; **bun.lock out of date** means `package.json` changed since the lockfile was written, and an install here follows the lockfile, so delete it to install from `package.json`), and whether your edits are saved (to this browser, or to the folder you opened; **Not saved** when another tab has the project open, which saves it instead). On a narrow window the port, format on save, the install state and the save state are left out. The Bun version links to [Bun compatibility](/compatibility/bun/). **Feedback** opens a form that sends a message to us, optionally with an email address to answer, the Bun release and browser, and the open project as a short link (see [Privacy](/privacy/#feedback)).
- **Open folder** or **Open zip file** loads a project from your computer (skips `node_modules` and `.git`). A zip whose files all sit in one folder, like GitHub's downloads, opens that folder. In Chrome, edits to an opened folder are saved back to it, and changes made to it in another editor show up in the playground.
- In Chrome and Edge, an opened folder stays linked: edits, new files and deletions are saved to it on disk. `node_modules` stays in the browser and the folder's own `node_modules` and `.git` aren't touched. A reload opens it again if the browser still allows access; otherwise pick **Reopen <folder>** in the project gallery, which asks once more. Other browsers open a copy.

Large files open and scroll quickly: the editor renders only the lines in view.

### Keyboard shortcuts

| Shortcut | Does |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> | Run |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> | Send the preview's request, from anywhere |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd> | Stop the server |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> | Save the file |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | Format the file with `bun fmt` (`format`) |
| <kbd>F12</kbd> | Go to the definition of the name at the cursor (`goToDefinition`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>I</kbd> | Show the type and docs of the name at the cursor (`showHover`); any key closes it |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Show completions at the cursor (`suggest`; <kbd>Ctrl</kbd> on macOS too) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> | Show the parameters of the call at the cursor (`signatureHelp`) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Delete</kbd> | Close the focused tab |
| <kbd>F2</kbd> | Rename the focused file or folder in the file tree |
| <kbd>Delete</kbd>, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Backspace</kbd> | Delete the focused file or folder in the file tree (asks first) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> (in the file tree) | Undo the last rename or delete |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>B</kbd> | Show or hide the file tree |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Show the Git view in place of the file tree (again: back to the files) |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>J</kbd> | Show or hide the console |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> | Show or hide the preview |
| <kbd>Esc</kbd> | Leave the expanded preview |
| <kbd>F8</kbd>, <kbd>F10</kbd>, <kbd>F11</kbd>, <kbd>Shift</kbd>+<kbd>F11</kbd> | While the [debugger](#debugger) is paused: resume, step over, step into, step out |

They work in the preview page too, and in an embed, where showing or hiding a pane works only for the panes its author didn't turn off (`features="-console"`). To change them, open the keyboard button in the header, click the pencil next to a command and press the new keys (<kbd>Esc</kbd> cancels, **Remove** unbinds it). Changed commands are marked **custom** with a button to reset them, a key bound to two commands is flagged on both, and **Save** keeps the changes. Keys the browser keeps for itself (<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd>) can't be recorded. Under **Edit as JSON** the same overrides can be written by hand: a command name to a chord, a list of chords, or `null` to turn it off, e.g. `{ "run": ["Mod+Enter", "Alt+R"], "togglePreview": null }`. `Mod` is <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> elsewhere; the other modifiers are `Ctrl`, `Alt`, `Shift` and `Meta`, and the space bar is `Space`. Overrides are kept in this browser for every project, and open playground tabs pick up changes right away.

## Console

A terminal with colors, clickable links, history (<kbd>↑</kbd>/<kbd>↓</kbd>) and line editing (<kbd>Ctrl</kbd>+<kbd>A</kbd>/<kbd>E</kbd>/<kbd>U</kbd>). <kbd>Ctrl</kbd>+<kbd>C</kbd> on an empty line stops the server; <kbd>Ctrl</kbd>+<kbd>L</kbd> clears.

| Command | Does |
|---|---|
| `bun run <script\|file>`, `bun <file>` | Run a `package.json` script or a file; `--preload <file>` (`-r`, `--require`, `--import`) runs a module first, after `bunfig.toml`'s `preload`, as in Bun |
| `bun test [-u] [--coverage] [-t pattern] [filter…]` | Run `*.test.*` / `*.spec.*` files with [`bun:test`](/compatibility/bun/#buntest); `--coverage` reports which lines and functions ran, `-t` runs the tests whose name matches (also `--timeout`, `--bail`, `--rerun-each`, `--todo`, `--only`) |
| `bun install` (`i`) | Install dependencies |
| `bun add <pkg[@range]> [-d]` (`a`) | Add a dependency |
| `bun remove <pkg>` (`rm`) | Remove a dependency |
| `bun pm cache [rm]` | Show or clear the package cache |
| `bun fmt [-c] [path…]` | Format files like Prettier, or only check them (`-c`) |
| `bun check [path…]` | Type check with Bun's own checker, as [`bun check`](/compatibility/toolchain/#bun-check) does |
| `git <command>` | Version control for the project: `init`, `status`, `add`, `commit`, `log`, `diff`, `show`, `branch`, `switch`, `restore`, `reset`, `config`… (see [Git](#git)) |
| `echo`, `cd`, `pwd`, `ls`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `cp`, `which`, `export`, `seq`, `yes`, `dirname`, `basename`, `true`, `false`, `exit` | Bun's shell builtins, over the project's files |
| `cookies [clear]` | List or clear the preview's cookies |
| `reset` | Throw away your changes and reload the project from its source |
| `clear`, `help` | |

The console is Bun's shell, the one [`Bun.$`](/compatibility/bun/) runs: quotes, pipes (`ls | cat`), `&&`, `||` and `;`, redirects (`echo hi > notes.txt`, `2>&1`), variables (`x=1`, `export`, `$x`), `$(…)`, globs (`ls src/*.ts`), `{a,b}` and subshells. `cd` changes the folder the next commands run in (the prompt shows it; `/` is the project). The console's own commands (`bun`, `git`, `cookies`…) take part too, though only their messages follow a pipe, not a running program's output. Commands outside this list aren't found, so no `bunx`, `grep` or `node` here. `bun run` of a `package.json` script that is more than a file or a bin (`tsc && vite build`) runs the script line in Bun's shell as the program, each of its commands a child process, as a running program's [`Bun.spawn`](/compatibility/bun/) and `child_process` start them.

### Console input

A program that reads its input (`process.stdin`, `Bun.stdin`, `for await (const line of console)`, `readline`, `prompt()`) gets what you type in the console. While it waits, <kbd>Enter</kbd> sends the line to the program instead of running it as a command, and the line stays in the output as in a terminal, after the program's prompt (`Name? Bob`). <kbd>Ctrl</kbd>+<kbd>D</kbd> on an empty line ends the input; after text it sends the text without a newline first. <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the program. Pasted text goes line by line. When the program isn't reading, the console is the shell again, also while a server runs. In an embed it is the same console. Output that ends without a newline (`process.stdout.write("Name? ")`) stays on its row for what comes next. A program that calls `process.stdin.setRawMode(true)` (a prompt library such as `@clack/prompts`, `readline` in terminal mode, a TUI) gets every key at once as the bytes a terminal sends (<kbd>Enter</kbd> `\r`, <kbd>Backspace</kbd> `\x7f`, arrows, <kbd>Tab</kbd>, <kbd>Esc</kbd>, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Delete</kbd>), without echo; <kbd>Ctrl</kbd>+<kbd>C</kbd> and <kbd>Ctrl</kbd>+<kbd>D</kbd> go to the program too, so the program decides whether to stop. The console draws what such a program writes, cursor movement and line clearing included. When the program leaves raw mode the console is line by line again. A program that runs with Local Bun doesn't get input yet. `prompt()`, `confirm()` and `alert()` need a cross-origin isolated page (see [Bun APIs](/compatibility/bun/#importmeta-and-globals)).

### Git

The status bar's change counter shows or hides it (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> does the same; the choice is kept for the tab); in an embed, a **Files | Git** switch sits above the tree. The **Git view** takes the tree's place, like Source Control in VS Code, and runs the same `git` as the console, so the two always show one repository:

- **No repository yet:** **Initialize repository** runs `git init`.
- **Branch:** the button at the top lists the branches (pick one to switch), creates a branch (**Create branch…**), merges another one into the current branch (**Merge into …**) or deletes another one (one whose commits are on no other branch only after a second **Delete anyway**). A switch git can't make because it would overwrite changed files says so in a box under the branch; the files stay as they were.
- **Merges and conflicts:** a merge (from the branch menu, **Pull**, or `git merge` in the console) that stops on conflicts shows a box with the merge's name and **Abort** (`merge --abort`, asks first), and lists the conflicted files under **Merge Changes**: open a file, fix the lines between `<<<<<<<` and `>>>>>>>`, then **Mark as resolved** (✓, `git add`; it asks first while the markers are still there). Once none are left, **Commit merge** makes the merge commit, with your message or git's (`Merge branch 'feat'`). A stash that conflicts when applied lists its files the same way. A rebase that stops (`git rebase`, or **Pull** with `pull.rebase` set) shows its branch and progress the same way; once the files are resolved, **Continue rebase** commits that step and replays the rest, **Skip this commit** leaves it out, and **Abort** puts the branch back.
- **Stashes:** the **⋯** menu's **Stash all changes** sets every change aside, new files too (`git stash -u`). **Stashes** lists them; hover one to apply it, pop it (apply and drop) or drop it, or click it to read its changes.
- **Pull and push:** a branch that tracks a remote one has ↓ (**Pull**) and ↑ (**Push**) next to it, each with how many commits it would move as of the last fetch. A branch that tracks none has **Publish** instead (`push -u` to `origin`). The **⋯** menu also has **Fetch**. A line under the branch says what's happening while they run, and a push GitHub refuses without an account offers **Sign in with GitHub**.
- **Commit:** type a message and press **Commit** (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> in the box). With nothing staged the button reads **Commit all** and stages every change first, as VS Code's smart commit does. The **⋯** menu has **Amend last commit** and **Undo last commit** (`reset --soft HEAD~1`: its changes stay staged).
- **Staged Changes** and **Changes:** each file with its folder and a letter (M modified, A added, D deleted, R renamed, U untracked). A staged rename shows as one renamed file, as git pairs them: the same content, or at least half of it; until it is staged, a moved file shows as deleted plus untracked. Hover a row to stage (+), unstage (−), discard (↺, asks first; an untracked file is deleted) or open the file; the section headers do the same for all files. Clicking a row opens the **Changes** tab at that file's diff.
- **History:** the last 50 commits; click one to read its `git show`.

With a repository that has a commit, the file tree marks changed, added, deleted and untracked files, and the **Changes** tab and the status bar's counter compare the files with the **last commit** instead of the project's source. The view follows your edits, and `git` commands typed in the console. Nothing of git loads (about 1.1 MB) until you open the Git view or run a `git` command; a project that already has a `.git/` reads it at once for the tree's marks. In an embed, Git is the `git` feature (the ⋯ menu's Git switch, or `-git` in `features`).

`git` runs [gitoxide](https://github.com/GitoxideLabs/gitoxide), a Git written in Rust, compiled to WebAssembly, on the project's files, in a background worker so a command never holds up the editor. `git init` makes a repository in `.git/`. git never sees `node_modules/` (it isn't committed in practice, and `git init` also lists it in `.git/info/exclude`), and it ignores executable bits, which the browser's files don't have. The repository is kept with the project in this browser and survives a reload, but it is not part of share links, downloads or a folder opened from disk, and the file tree doesn't list `.git/`. `reset` (the console command) throws it away with your other changes.

What works: `init`, `status` (`-s`, `-b`, `--porcelain`, `-z`, `-uall`; it says whether your branch is ahead of or behind its upstream, as git does), `add` (paths, `.`, `-A`, `-u`), `rm` (`--cached`), `commit` (`-m`, `-a`, `--amend`, `--allow-empty`), `log` (`--oneline`, `--format`, `-n`, `--all`, `-- <path>`), `diff` (and `--cached`), `show` (a commit, or `<rev>:<path>`), `branch` (list, create, `-d`/`-D`, `-m`), `switch` and `checkout` (`-c`/`-b`, `--detach`, paths; leaving a detached HEAD warns about commits no branch keeps, as git does), `restore` (`--staged`, `--source`), `reset` (`--soft`, `--mixed`, `--hard`, paths), `clean`, `config` (this repository's `.git/config`: `git config user.name "Ada"` signs your commits; otherwise they're signed `Playground <playground@runbun.dev>`) and `rev-parse`. Like git, `switch` and `checkout` refuse to overwrite changes you haven't committed. Paths are files or folders, not globs. `merge` (`--no-ff`, `--ff-only`, `-m`, `--abort`, `--no-commit`, `--squash`, `-s ours`, `-X ours`/`-X theirs`, `-X no-renames`, `-X diff-algorithm=histogram`) fast-forwards or makes a merge commit, also of several branches at once (an octopus merge); where both branches changed the same lines it stops with conflict markers in the files, as git does: edit them, `git add` the files and `git commit`, or `git merge --abort`. `tag` lists (`-l <pattern>`, `-n`, `-i`, `--sort`, e.g. `--sort=-v:refname`, which puts `v1.0-rc1` before `v1.0` once `git config versionsort.suffix -rc` is set, `--contains`, `--merged`, `--points-at` and `--format`, e.g. `--format='%(refname:short) %(subject)'`, with `%(align)` and `%(if)…%(then)…%(else)…%(end)`), creates (lightweight, or annotated with `-a`, `-m` or `-F <file>`; not signed) and deletes (`-d`) tags. `stash` (`-m`, `-u`, `-a`, `-k`, `--staged`, paths after `--`, `list`, `show`, `apply`, `pop`, `drop`, `clear`, `branch`, `create`, `store`; not `--patch`, which asks hunk by hunk) sets your changes aside and brings them back; a stash conflicts like a merge does. `rebase` (`--onto`, `-X ours`/`-X theirs`, `--autostash` or `git config rebase.autoStash true` to set your uncommitted changes aside and bring them back after, `--continue`, `--skip`, `--abort`, `--quit`) replays your branch's commits onto another one (or another branch's: `git rebase main feat`; with no upstream named, it rebases onto the branch's upstream from where your branch forked from it, as git's `--fork-point` does, so commits a force-push removed upstream stay removed), leaving out those it already has; a conflict stops it with markers in the files, as git does: fix them, `git add` and `git rebase --continue` (a `git commit` without `-m` in between takes the stopped commit's message; the Git view shows the rebase with **Continue rebase**, **Skip this commit** and **Abort**). Not `rebase -i`, `--exec` or `--rebase-merges`.

With remotes on GitHub, GitLab, Codeberg or Bitbucket (`https://` URLs): `remote` (`-v`, `add`, `remove`, `get-url`, `set-url`), `fetch` (`--depth`), `pull` (fetches and merges, as git's `pull.rebase=false` does, or fast-forwards; `--ff-only`, `--no-ff`; `--rebase`, or `git config pull.rebase true`, rebases your commits onto the fetched ones instead), `clone` (`--depth`, `-b`) into an empty project (or **With Git history** in the gallery, which makes one), and `push` (`-u`, `-f`, `-d`, `<src>:<dst>`; refused when the remote has commits you don't, unless forced), also from the Git view's pull and push buttons. Private GitHub repositories and pushing to GitHub work once you sign in with GitHub (the Git view's ⋯ menu, or **Clone a repository**, which then lists your repositories; see [Privacy](/privacy/#sign-in-with-github)) and grant runbun.dev the repository; other hosts are public and read-only. Git hosts don't let a browser page talk to them directly, so these requests go through runbun.dev's git proxy, which passes them on unchanged and keeps nothing (see [Privacy](/privacy/)).

## Running code

**Run** starts your code in a Web Worker. It runs the first of:

1. `module` or `main` in `package.json`
2. the file in `scripts.dev` or `scripts.start` (`"dev": "bun --watch src/index.ts"` works, and so does `"dev": "bun --preload ./setup.ts src/index.ts"`, which runs through Bun's shell)
3. `index.ts`, `index.tsx`, `index.js` or `src/index.ts`

- Press **Run** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>) again to restart. Stop with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd>, or <kbd>Ctrl</kbd>+<kbd>C</kbd> in the console.
- **Watch** (on by default; the refresh icon next to Run, beside Auto-save): saving an edit restarts the running program and clears the console, like `bun --watch`. A crash doesn't end it: the status says so and the next save runs the program again. A save that leaves an open file with a syntax error (half-typed, as auto-save saves it) keeps the program running as it was until a save parses. Stop, or a program that exits by itself, ends it until the next Run. In the browser a restart has no gap: the edited program starts next to the running one, which keeps answering the preview until the new one is up, then finishes the requests it had begun (up to 5 seconds); the preview's WebSockets reconnect to the new one. If the edited program throws while starting, or doesn't start within 15 seconds, the running one keeps going and the status says the last save didn't start. Lines the previous program logs in the meantime start with `[previous]`. Database writes the previous program makes while both run are not carried over. With Local Bun the program restarts, and the preview's requests wait for it.
- With Watch off, edits still reach the running code: the next import or request sees them, and `fs.watch` fires. A script's `--watch` and `--hot` flags are ignored either way.
- A file location in the console (`index.ts:3:7` in an error or a stack trace) is a link: click it to open the file there.
- A script runs when it is `bun <file>` or calls one installed package's bin: with no entry file, Run starts the `dev` (else `start`) script, so `"dev": "vite"` runs Vite's CLI with its arguments. Scripts that chain commands (`tsc && …`), pipe, set variables or use `npx` can't run; start those tools from a file instead (see [Frameworks](/compatibility/frameworks/)).

### Debugger

Pause your program at a line and look around, without leaving the playground.

1. Turn on **Debug**, the bug icon in the header or the status bar. A Debug panel opens above the console.
2. Click a line number to set a breakpoint, a small red dot beside the number. Click again to remove it. A `debugger;` statement in your code pauses there too.
3. Press **Run**. Debug applies to runs started after you turn it on.

When the program reaches a breakpoint, the line is highlighted and the file opens there. While it's paused, the server doesn't answer the preview, which waits. The panel shows:

- **Call stack:** the functions that led there. Click one to open its line.
- **Variables:** the paused function's own variables, those of the blocks around the line, and the file's top-level ones.
- **Evaluate:** type an expression and press <kbd>Enter</kbd>. It runs where the program is paused, with its variables in scope.

**Resume** (<kbd>F8</kbd>), **Step over** (<kbd>F10</kbd>), **Step into** (<kbd>F11</kbd>) and **Step out** (<kbd>Shift</kbd>+<kbd>F11</kbd>) continue from there. Step out stops at the next statement after the function returns.

Breakpoints work in your project's own files, including files loaded with `require()`, but not in `node_modules`. A debug run is slower, up to several times in tight loops, so turn Debug off when you're done. Debug needs a cross-origin isolated page, which runbun.dev is in Chrome, Edge and Firefox (see [Browsers](/compatibility/browsers/)). An embed shows no Debug button.

## Preview

When your code starts a server (`Bun.serve`, `node:http`, or `export default { fetch }`), the preview shows it. With several, it shows the program's first; a program that serves nothing itself shows the first server one of its child processes starts (a `package.json` script that runs `bun server.ts`, a `Bun.spawn`), and the status bar lists those ports too. To see another of them, pick it in the status bar's port list (in an embed, the ⋯ menu's **Preview port**): the preview loads again from that server, and its WebSockets that name no port go there too, for as long as it runs. When it stops, the preview goes back to the default.

- **Request bar:** send any method, path and body. The request panel under it (its toggle sits next to Send) has Params, Headers, Auth and Body, and a Raw switch. Params lists the path's query as rows and writes your edits back into the path. Params and headers are rows you can turn off one by one; a param turned off leaves the path and keeps its place until you turn it on again. Every header reaches the server, including ones a page's `fetch` can't set, such as `Cookie`, `Origin` and `Referer`. A `Cookie` is joined with the cookies the app has set, and yours wins when a name is in both. An HTML page you send headers to gets them on its first load, but not its scripts, fetches or links. Auth sends a Bearer token, Basic credentials or an API key, the key as a header or a query parameter. What it adds shows as a read-only row under Headers or Params, and a header row with the same name wins over it. A body is sent as JSON or text, written in the same editor as files (Format, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> in the body, indents a JSON body), or as a form, from rows. A GET or HEAD request has no body; Body says so and offers to switch to POST. A form is URL-encoded, or multipart, where a row can send a file from the project. Raw shows the whole request as `.http` text in place of the section: the request line, a header per line (`#` turns one off), a blank line and the body. Edit it there and the other sections follow. The copy menu copies the request as a curl command or a `fetch` call for `http://localhost:3000`, where the app runs when you start it locally with `bun`. A response from before the request last changed is dimmed, with a note to send it again. Each preview tab keeps its own params, headers, auth and body. HTML responses open in the page; anything else shows status, headers and the body: JSON formatted, and JSON, HTML, CSS, JavaScript, XML and Markdown highlighted. A link or redirect in a page that leads to JSON or plain text shows it the same way, with its status but not its headers (the request isn't sent again; press Send for them).
- **Tabs:** several previews at once. <kbd>Cmd</kbd>-click (<kbd>Ctrl</kbd>-click off macOS) or middle-click a link in a page to open it in a new preview tab in the background; add <kbd>Shift</kbd> to switch to it.
- **Open in a new tab:** the page gets its own browser tab, still served by the playground (keep the playground tab open).
- **Requests stay inside:** `fetch("/api/x")`, links, forms and redirects from the preview page reach your server.
- **WebSockets:** the preview page's `WebSocket` connects to your server (`Bun.serve` `upgrade`, `node:http` `upgrade`, the `ws` package). `localhost:<port>` URLs pick the server on that port. The program's own `new WebSocket("ws://localhost:<port>")` reaches its servers too.
- **Streaming:** streamed responses and Server-Sent Events arrive as they're sent.
- **Cookies:** kept in the browser across restarts, where the preview's scripts read and set them with `document.cookie` and DevTools lists them (HttpOnly ones stay hidden from scripts and DevTools); see them with `cookies`.
- **HTML imports:** `import page from "./index.html"` in `Bun.serve` routes is bundled with Bun's bundler.
- The preview follows the playground's light/dark mode.

Limits: the server isn't reachable from outside the browser, there's no HTTP caching (conditional requests are dropped), and only the preview page can open WebSockets to it.

### Fast path for browser-only projects

Experimental, and off unless you ask: turn on **Fast path** (the lightning icon next to Auto-save and Restart on save in the header; the setting is remembered), or open the playground with `?fast` added to the URL (handy in a link), and a browser-only project runs without `bun install` and without a worker. Each file is transpiled on its own, the project's packages load from [esm.sh](https://esm.sh) through an import map, and the page appears as soon as they arrive, usually a second or two sooner than the first run of a normal install. The console says `[fast] packages come from https://esm.sh`. Turning the toggle on or off applies from the next **Run**.

- **What qualifies:** an `index.html` at the project's root, with no project file that uses `Bun.`, `node:`, `bun:`, `require()` or `process.env`, `process.argv` or `process.cwd`. Otherwise the project runs the normal way, and the console says which file ruled it out (`[fast] not used, running normally: index.ts uses Bun.`).
- **Packages:** versions come from `bun.lock`, else from the `package.json` range. The package names and versions are sent to esm.sh, a third-party service, so the page needs a network and doesn't work offline, and `node_modules` isn't used or written.
- **The page** runs in a sandboxed frame (scripts, forms, dialogs, popups and downloads; no access to the playground's storage). Uncaught errors and unhandled rejections show in the console.
- **Not supported:** assets loaded with `import.meta.url`, `fetch` to a server of the project (there is none), Solid's JSX (it needs its own compiler), and source-mapped stack traces.

For example, a React counter qualifies: it has an `index.html` at the root and nothing that needs Bun or Node.

```html title="index.html"
<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

```tsx title="main.tsx"
import { useState } from "react";
import { createRoot } from "react-dom/client";

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>;
}

createRoot(document.getElementById("root")!).render(<Counter />);
```

```json title="package.json"
{
  "name": "fast-counter",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

[Open it in the playground with the fast path on](https://runbun.dev/?fast#code=XVHBbtswDP0Vlicbc-3kOMf2YcUOvXbHaQNciem02pQh0UEDw_8-SHYyoCcRfO-Rj3oLXrA-Fni2AwWsF7Rs6KP8I-OANTYPxmm5TgSx0Slu9hegeXXmmiqAxtgLWNMq9M6Jwq6pjL3cwKC9nQTimFbh6Mw8kEIIXrcKq7G3XEr4SKqNus2v9gVNte_EAm9krNGOk_MCC8yBfkgvBCucvRtBoadei8KT4jtJe-qFXpyTT7RH48ZKD5Z4Uyg-z6zFOoYnN7OQz3JYoiHtOAj81LFbQCBJ-C9o7w6yQ36KTE8ye4bmdRZxDI6fBqvf2yXLoe3uyixNgi9wzNcuMcjAkporiB0pNNU2oTspXqO1_1dkxul5JJbyjeT7QLH8dn022S2C_CEvPbEhnzX7IVB10R8WOPX6vX-j8m9wjDWm8xRyP5LCGhSe-yCPyQl5hcUGT95eekkM8TPt3ZjqJroFuwOGprietaUQCWlJBPZ0ouT38Wt5KA-75g7GTD4RIr6mX8B1_Qc), and press **Run**: no install, and the console lists `react` and `react-dom` from esm.sh.

## Installing packages

Dependencies install automatically when one of your own projects or an example opens with missing packages (a project from a link waits for Run, which installs first). `bun install` uses `bun.lock` when there is one. Details and limits are in [Toolchain](/compatibility/toolchain/#bun-install).

## Projects

- **Saved as you type**, in your browser. See [Storage and persistence](/guides/storage/).
- **Share:** the Share menu copies a link with the whole project in the URL (nothing is uploaded), a Markdown badge, or HTML. `node_modules`, `.git`, binary files and secrets (`.env`, keys, `.npmrc`) are left out. Very long links can be shortened to `runbun.dev/s/<id>`, which stores a copy on runbun.dev (see [Privacy](/privacy/)). **Download as zip** saves every file except `node_modules` and `.git`, binaries included.
- **Repositories:** **Repository…** in the project gallery opens a public repo two ways. **Files** (the default, or `?repo=`) brings a GitHub repo's files, branch or subfolder without their history: up to 500 files, and GitHub allows 60 imports an hour per IP. **With Git history** (or `?git=<url>`) clones a repository from GitHub, GitLab, Codeberg or Bitbucket with its last 50 commits (the status bar shows how much has arrived), so you can commit, branch, fetch and pull in the [Git](#git) view; the Git view's **Clone a repository…** opens the same choice.
- **Project gallery:** the project button in the header opens a gallery of starters (Blank, HTTP API, React, SQLite, WebSocket chat), and examples (Elysia, Hono, Lit SSR, Astro + Solid, Vite and more), in sections down the side. Search by name or technology, or narrow it with the technology tags. Open a folder, a zip or a repository from the same gallery. A project opens in place, without reloading the page; Back and Forward go between the projects you opened. The starters and examples live in [runbun-examples](https://github.com/oddcelot/runbun-examples): add yours with a pull request.
- **Project config:** an optional [`runbun.json`](/guides/project-config/) says what Run starts, sets environment variables, picks the open tabs, panels, their sizes and preview requests, and keeps files from edits.
- **One tab per project:** a second tab with the same project can't save its changes.

## Embedding

Any project can be put in another page, as a `<bun-playground>` element or an iframe. See [Embedding](/guides/embedding/) and the [embed reference](/reference/embed-api/).

### Links

| URL | Opens |
|---|---|
| `runbun.dev` | A short intro with a live example, on a first visit; **Open the playground** starts the playground in the same page. After that, `runbun.dev` opens the demo project directly |
| `/about` | The intro, always (also linked as **About** in the status bar) |
| `?example=<name>` | A bundled example, e.g. `?example=elysia-demo` |
| `?repo=owner/repo` | A GitHub repo's files. Also `owner/repo@ref`, a github.com URL, or `…/tree/<ref>/<dir>` |
| `?git=<url>` | A clone of a repository (`owner/repo` or an https URL on GitHub, GitLab, Codeberg or Bitbucket), with its last 50 commits |
| `#code=…` | A shared project |
| `/s/<id>` | A short share link |

Your saved changes win over the link's source; use `reset` to start over from it.

A project that comes from a link (`#code=…`, `/s/<id>`, `?repo=` or `?git=`) opens in the editor but doesn't run until you press Run, so you can read it first. Your own saved projects and the bundled examples run as soon as they open.

`?vars=` sets the overlay drawn over the whole page, for this visit only: Share links drop it and the next visit doesn't remember it. It takes a JSON object with `base` (both schemes) and optionally `light` or `dark`, each with `--overlay` (a wash) and `--overlay-ring` (a 1px border), e.g. `?vars={"base":{"--overlay-ring":"linear-gradient(135deg,%23f9d6e3,%23a8cdf0)"}}`. Other names are ignored, and a value may only use colors, `none`, and the functions `linear-gradient`, `radial-gradient`, `conic-gradient` (and their `repeating-` forms), `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, `color-mix`, `light-dark` and `calc`; no images or `var()`. `none` or `""` turns off the theme's own overlay (the Elysia family has one). An embed doesn't draw this overlay; style `bun-playground::part(overlay)` on the host page instead (see the [embed reference](/reference/embed-api/#theming)).
