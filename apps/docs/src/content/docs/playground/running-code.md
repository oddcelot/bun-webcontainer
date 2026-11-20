---
title: Running code and the debugger
description: "How Run picks and starts your program, what Watch restarts, and how to pause at a breakpoint with the debugger."
sidebar:
  order: 4
---

**Run** starts your code in a Web Worker. The debugger pauses it at a line so you can look around.

It runs the first of:

1. `module` or `main` in `package.json`
2. the file in `scripts.dev` or `scripts.start` (`"dev": "bun --watch src/index.ts"` works, and so does `"dev": "bun --preload ./setup.ts src/index.ts"`, which runs through Bun's shell)
3. `index.ts`, `index.tsx`, `index.js` or `src/index.ts`

- Press **Run** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd>) again to restart. Stop with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>.</kbd>, or <kbd>Ctrl</kbd>+<kbd>C</kbd> in the console.
- <details>
  <summary><strong>Watch</strong> (on by default, the refresh icon next to Run) restarts the running program when you save, and clears the console, like <code>bun --watch</code>.</summary>

  **What restarts and what reloads**

  - In the browser, a save that only changes files the page loads (its scripts, stylesheets and what they import) and the program doesn't import reloads the preview and keeps the program running.
  - If the program watches those files itself (`fs.watch`, as Vite's dev server does), the preview is not reloaded either: the program updates the page, so hot module replacement keeps the page's state.
  - `package.json`, installed packages, the program's own imports and files it reads at run time still restart it.

  **Crashes, syntax errors and exits**

  - A crash doesn't end it: the status says so and the next save runs the program again.
  - A save that leaves an open file with a syntax error (half-typed, as auto-save saves it) keeps the program running as it was until a save parses.
  - Stop, or a program that exits by itself, ends it until the next Run.

  **A restart has no gap (in the browser)**

  - The edited program starts next to the running one, which keeps answering the preview until the new one is up, then finishes the requests it had begun (up to 5 seconds); the preview's WebSockets reconnect to the new one.
  - If the edited program throws while starting, or doesn't start within 15 seconds, the running one keeps going and the status says the last save didn't start.
  - Lines the previous program logs in the meantime start with `[previous]`.
  - Database writes the previous program makes while both run are not carried over.

  **With Local Bun**

  The program restarts, and the preview's requests wait for it.

  </details>
- With Watch off, edits still reach the running code: the next import or request sees them, and `fs.watch` fires. A script's `--watch` and `--hot` flags are ignored either way.
- A file location in the console (`index.ts:3:7` in an error or a stack trace) is a link: click it to open the file there.
- <details>
  <summary><strong>Scripts</strong> run when they are <code>bun &lt;file&gt;</code> or call one installed package's bin; with no entry file, Run starts the <code>dev</code> (else <code>start</code>) script.</summary>

  So `"dev": "vite"` runs Vite's CLI with its arguments. Scripts that chain commands (`tsc && …`), pipe, set variables or use `npx` can't run; start those tools from a file instead (see [Frameworks](/compatibility/frameworks/)).

  </details>

## Debugger

Pause your program at a line and look around, without leaving the playground.

:::note
The debugger is a prototype and off by default, runbun.dev included. A [self-hosted copy](/guides/self-hosting/) turns it on with `"debugger": true` in its hosting file.
:::

1. Turn on **Debug**, the bug icon in the header or the status bar. A Debug panel opens above the console.
2. Click a line number to set a breakpoint, a small red dot beside the number. Click again to remove it. A `debugger;` statement in your code pauses there too.
3. Press **Run**. Debug applies to runs started after you turn it on.

When the program reaches a breakpoint, the line is highlighted and the file opens there. While it's paused, the server doesn't answer the preview, which waits. The panel shows:

- **Call stack:** the functions that led there. Click one to open its line.
- **Variables:** the paused function's own variables, those of the blocks around the line, and the file's top-level ones.
- **Evaluate:** type an expression and press <kbd>Enter</kbd>. It runs where the program is paused, with its variables in scope.

**Resume** (<kbd>F8</kbd>), **Step over** (<kbd>F10</kbd>), **Step into** (<kbd>F11</kbd>) and **Step out** (<kbd>Shift</kbd>+<kbd>F11</kbd>) continue from there. Step out stops at the next statement after the function returns.

Breakpoints work in your project's own files, including files loaded with `require()`, but not in `node_modules`. A debug run is slower, up to several times in tight loops, so turn Debug off when you're done. Debug needs a cross-origin isolated page, which runbun.dev is in Chrome, Edge and Firefox (see [Browsers](/compatibility/browsers/)). An embed shows no Debug button.
