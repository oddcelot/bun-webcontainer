---
title: Console
description: "The playground's console: a Bun shell terminal with its commands, history and line editing, and how a program reads input typed into it."
sidebar:
  order: 2
---

The console is a terminal under the editor. It shares that pane with the [debugger](/playground/running-code/#debugger) and [the devtools](/playground/preview/#devtools) (Solid's, Vue's or Nuxt's), each a tab, and comes forward when a run fails. It runs `bun` and `git` commands, a shell over the project's files, and shows your program's output.

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
| `git <command>` | Version control for the project: `init`, `status`, `add`, `commit`, `log`, `diff`, `show`, `branch`, `switch`, `restore`, `reset`, `config`… (see [Git](/playground/git/)) |
| `echo`, `cd`, `pwd`, `ls`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `cp`, `which`, `export`, `seq`, `yes`, `dirname`, `basename`, `true`, `false`, `exit` | Bun's shell builtins, over the project's files |
| `cookies [clear]` | List or clear the preview's cookies |
| `reset` | Throw away your changes and reload the project from its source |
| `clear`, `help` | |

The console is Bun's shell, the one [`Bun.$`](/compatibility/bun/) runs: quotes, pipes (`ls | cat`), `&&`, `||` and `;`, redirects (`echo hi > notes.txt`, `2>&1`), variables (`x=1`, `export`, `$x`), `$(…)`, globs (`ls src/*.ts`), `{a,b}` and subshells.

<details>
<summary>How <code>cd</code>, the console's own commands and <code>bun run</code> scripts behave</summary>

- `cd` changes the folder the next commands run in (the prompt shows it; `/` is the project).
- The console's own commands (`bun`, `git`, `cookies`…) take part too, though only their messages follow a pipe, not a running program's output.
- Commands outside this list aren't found, so no `bunx`, `grep` or `node` here.
- `bun run` of a `package.json` script that is more than a file or a bin (`tsc && vite build`) runs the script line in Bun's shell as the program, each of its commands a child process, as a running program's [`Bun.spawn`](/compatibility/bun/) and `child_process` start them.

</details>

## Console input

A program that reads its input (`process.stdin`, `Bun.stdin`, `for await (const line of console)`, `readline`, `prompt()`) gets what you type in the console. While it waits, <kbd>Enter</kbd> sends the line to the program instead of running it as a command, and the line stays in the output as in a terminal, after the program's prompt (`Name? Bob`).

<details>
<summary>Ending input, raw mode, and what doesn't get input yet</summary>

**Line input**

- <kbd>Ctrl</kbd>+<kbd>D</kbd> on an empty line ends the input; after text it sends the text without a newline first.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the program.
- Pasted text goes line by line.
- When the program isn't reading, the console is the shell again, also while a server runs.
- In an embed it is the same console.
- Output that ends without a newline (`process.stdout.write("Name? ")`) stays on its row for what comes next.

**Raw mode**

A program that calls `process.stdin.setRawMode(true)` (a prompt library such as `@clack/prompts`, `readline` in terminal mode, a TUI) gets every key at once as the bytes a terminal sends (<kbd>Enter</kbd> `\r`, <kbd>Backspace</kbd> `\x7f`, arrows, <kbd>Tab</kbd>, <kbd>Esc</kbd>, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Delete</kbd>), without echo. <kbd>Ctrl</kbd>+<kbd>C</kbd> and <kbd>Ctrl</kbd>+<kbd>D</kbd> go to the program too, so the program decides whether to stop. The console draws what such a program writes, cursor movement and line clearing included. When the program leaves raw mode the console is line by line again.

**Limits**

- A program that runs with Local Bun doesn't get input yet.
- `prompt()`, `confirm()` and `alert()` need a cross-origin isolated page (see [Bun APIs](/compatibility/bun/#importmeta-and-globals)).

</details>
