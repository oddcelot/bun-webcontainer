---
title: Editor and files
description: "The playground's editor and file tree: tabs, auto-save, formatting, TypeScript completions, the Changes diff, the status bar, opening folders and zips, and keyboard shortcuts."
sidebar:
  order: 1
---

The editor is where you write the project's files, with a file tree, tabs and a status bar. It type checks TypeScript as you type and saves to your browser.

- <details>
  <summary><strong>Syntax-highlighted editor</strong> with themes and light/dark mode, and CSS and HTML highlighted inside <code>css</code> and <code>html</code> tagged templates.</summary>

  CSS in a `css` tagged template and HTML in an `html` one (Lit, styled-components) are highlighted as CSS and HTML, and the CSS gets hovers, completions and warnings (an unknown property, an empty rule) as in a stylesheet.

  Each file keeps its undo history while the page is open: switching tabs and back, or renaming the file, doesn't lose it. A file changed outside the editor (by your program, or in an opened folder by another editor) starts a fresh history.

  </details>
- <details>
  <summary><strong>File tree</strong> with search and a "New file" button; right-click a file or folder to <strong>rename</strong> or <strong>delete</strong> it, or press <kbd>F2</kbd> or <kbd>Delete</kbd>.</summary>

  Right-click a file or folder (or use its ⋯ button) to **rename** or **delete** it, or to add a file to a folder.

  - <kbd>F2</kbd> renames the focused row in place.
  - <kbd>Delete</kbd> (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Backspace</kbd>) deletes it after asking.
  - Open tabs follow a rename and close when their file is deleted; with Watch on, either restarts the program.

  For ten seconds after, **Undo** under the tree (or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> in the tree) brings a deleted file or folder back, tabs included, or moves a renamed one back. In an opened folder, both reach the folder on disk.

  </details>
- Tabs for open files: close with the × button, <kbd>Delete</kbd>, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>W</kbd>
- <details>
  <summary><strong>Auto-save</strong> saves your edits a moment after you stop typing (on by default).</summary>

  Switch it off with the save icon next to Run (in an embed, the tab bar's Auto-save switch) to save with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> instead.

  Unsaved tabs show a dot, and Run, Install, `bun test` and Share save everything first. The setting applies to every project and every open playground tab.

  </details>
- **Format** (top right of the code while the pointer is over it, or <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>) formats the open file with `bun fmt`, as one undoable edit (see [Toolchain](/compatibility/toolchain/#formatter-bun-fmt))
- <details>
  <summary><strong>Type errors and completions</strong> for TypeScript files, plus hovers, go to definition (<kbd>F12</kbd>) and parameter hints, from TypeScript 7's checker.</summary>

  Type errors in TypeScript files, a name's type and documentation when the pointer rests on it, and **completions** as you type, come from TypeScript 7's checker (see [Toolchain](/compatibility/toolchain/#type-checking)).

  **Completions**

  - The list opens after `.`, in import paths, and at the first letter of a name; <kbd>↑</kbd>/<kbd>↓</kbd> pick, <kbd>Enter</kbd> or <kbd>Tab</kbd> insert, <kbd>Esc</kbd> closes it.
  - The selected entry's type and docs show under the list.
  - Names exported by the project's other files, installed packages and Bun's and Node's built-in modules (`bun:sqlite`, `node:fs`) are offered too, with the module they come from, and inserting one adds its import.

  **Go to definition**

  <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click a name (or press <kbd>F12</kbd>) to **go to its definition**, in another file too, or in TypeScript's and Bun's own types (`lib.es5.d.ts`, `bun-types`), which open read-only in a tab with a lock.

  **Parameter hints**

  Typing `(` or `,` in a call shows its **parameter hints** above the line, with the current parameter underlined; <kbd>↑</kbd>/<kbd>↓</kbd> step through overloads and <kbd>Esc</kbd> hides them.

  </details>
- <details>
  <summary><strong>Changes</strong> opens a diff of each file that differs from the project's source, or from the last Git commit once there is one.</summary>

  Once the project has a Git commit, this compares with the last commit instead (see [Git](/playground/git/)).

  - The counter in the status bar shows how many files differ from the project's source (the demo, the example, the shared link, the GitHub repo, or the folder or zip as opened).
  - It opens the Git view (in an embed with Git off, the tab itself), whose **Show all changes** (or, without a repository, **Compare with the project's source**) opens a **Changes** tab with a diff of each one: modified, added and deleted files, updated as you save.
  - **Open** in a file's header edits it.
  - After a reload the comparison still goes back to the source, not to the restored copy; for a GitHub repo the files are fetched again when the tab first opens.
  - `node_modules` and `.git` aren't compared, and binary files are listed without a diff.

  </details>
- Resizable panes
- <details>
  <summary><strong>Run status</strong> shows as a pill in the status bar (default) or a toast over the panes; pick one under <strong>Appearance</strong>.</summary>

  The toast fades a few seconds after the program settles; errors stay until the next change.

  </details>
- <details>
  <summary><strong>Status bar</strong> along the bottom: pane buttons, what the program is doing and its port, the open file's errors and cursor, format on save, install state and save state.</summary>

  **Panes and the program**

  - Buttons show or hide the file tree, the preview, the console and the [debugger](/playground/running-code/#debugger) (with both of those hidden, the editor takes their room).
  - What the program is doing and the port it serves (`:3000`; click to show the preview when it's hidden; with several, `:3000 +1` opens a list of them that picks the one the preview shows).

  **The open file**

  Its error and warning counts (click to go to the next one), the cursor's line and column, and its language (for TypeScript, with the version the type checker follows).

  **Saving and installing**

  - **Format on save** (the wand): saving with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> runs `bun fmt` on the file first; saves as you type don't, and a file `bun fmt` can't format saves as it is.
  - Whether the dependencies are installed (how many; **Not installed** installs them; **bun.lock out of date** means `package.json` changed since the lockfile was written, and an install here follows the lockfile, so delete it to install from `package.json`).
  - Whether your edits are saved (to this browser, or to the folder you opened; **Not saved** when another tab has the project open, which saves it instead).
  - On a narrow window the port, format on save, the install state and the save state are left out.

  **Links**

  - The Bun version links to [Bun compatibility](/compatibility/bun/).
  - **Feedback** opens a form that sends a message to us, optionally with an email address to answer, the Bun release and browser, and the open project as a short link (see [Privacy](/privacy/#feedback)).

  </details>
- <details>
  <summary><strong>Open folder</strong> or <strong>Open zip file</strong> loads a project from your computer, skipping <code>node_modules</code> and <code>.git</code>.</summary>

  A zip whose files all sit in one folder, like GitHub's downloads, opens that folder. In Chrome, edits to an opened folder are saved back to it, and changes made to it in another editor show up in the playground.

  </details>
- <details>
  <summary><strong>In Chrome and Edge, an opened folder stays linked:</strong> edits, new files and deletions are saved to it on disk.</summary>

  `node_modules` stays in the browser and the folder's own `node_modules` and `.git` aren't touched. A reload opens it again if the browser still allows access; otherwise pick **Reopen <folder>** in the project gallery, which asks once more. Other browsers open a copy.

  </details>

Large files open and scroll quickly: the editor renders only the lines in view.

## Keyboard shortcuts

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
| <kbd>F8</kbd>, <kbd>F10</kbd>, <kbd>F11</kbd>, <kbd>Shift</kbd>+<kbd>F11</kbd> | While the [debugger](/playground/running-code/#debugger) is paused: resume, step over, step into, step out |

They work in the preview page too, and in an embed, where showing or hiding a pane works only for the panes its author didn't turn off (`features="-console"`).

<details>
<summary>Change a shortcut: the keyboard button, <strong>Edit as JSON</strong> and the chord syntax</summary>

**Recording a new key**

- Open the keyboard button in the header, click the pencil next to a command and press the new keys (<kbd>Esc</kbd> cancels, **Remove** unbinds it).
- Changed commands are marked **custom** with a button to reset them, a key bound to two commands is flagged on both, and **Save** keeps the changes.
- Keys the browser keeps for itself (<kbd>Cmd</kbd>+<kbd>W</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd>) can't be recorded.

**Edit as JSON**

Under **Edit as JSON** the same overrides can be written by hand: a command name to a chord, a list of chords, or `null` to turn it off, e.g. `{ "run": ["Mod+Enter", "Alt+R"], "togglePreview": null }`. `Mod` is <kbd>Cmd</kbd> on macOS and <kbd>Ctrl</kbd> elsewhere; the other modifiers are `Ctrl`, `Alt`, `Shift` and `Meta`, and the space bar is `Space`.

**Where they are kept**

Overrides are kept in this browser for every project, and open playground tabs pick up changes right away.

</details>
