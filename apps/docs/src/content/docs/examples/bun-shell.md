---
title: "Bun.$ shell example: run shell commands from TypeScript"
description: "Use Bun's shell from TypeScript: pipes, redirects, globs, escaped template values, .text() and .lines(), and ShellError, in a runnable example in your browser."
sidebar:
  order: 7
  label: Bun.$ shell
---

`Bun.$` runs shell commands from a template string, with Bun's own shell: the same parser, the same builtins. Press **Run**; the commands work on the project's files, in your browser.

```ts playground
import { $ } from "bun";

// Commands, redirects and && work as in a shell.
await $`mkdir -p notes && echo "buy milk" > notes/todo.txt && echo "call Ada" >> notes/todo.txt`;
await $`touch notes/a.md notes/b.md`;

// A glob, and the output as a string.
console.log(await $`ls notes/*.md`.text());

// Values in ${} are escaped: a name with a space stays one argument.
const name = "meeting notes.txt";
await $`echo "agenda: the shell" > notes/${name}`;
console.log(await $`cat notes/${name}`.text());

// Line by line, through a pipe.
for await (const line of $`cat notes/todo.txt | cat`.lines()) {
  if (line) console.log("todo:", line);
}

// JSON output, parsed.
const status = await $`echo ${JSON.stringify({ ok: true, files: 4 })}`.json();
console.log(status.files);

// A failing command throws a ShellError, unless you ask for .nothrow().
try {
  await $`cat notes/missing.txt`.quiet();
} catch (err) {
  console.log(err.exitCode, err.stderr.toString().trim());
}
const { exitCode } = await $`ls notes/nope`.nothrow().quiet();
console.log("exit code", exitCode);
```

## How it works

- **`` $`…` ``** parses the command with Bun's shell grammar and runs it when you `await` it (or call `.text()`, `.json()`, `.lines()`). Output also prints to the console unless you add **`.quiet()`**.
- **Template values** are escaped as one word each, so file names with spaces or quotes can't break the command; an array becomes several words.
- **`.text()`, `.json()`, `.lines()`, `.bytes()`, `.blob()`** read the command's stdout. Awaiting the command itself gives `{ stdout, stderr, exitCode }`, with `stdout` and `stderr` as `Buffer`s.
- **A non-zero exit** rejects with a `ShellError` carrying `exitCode`, `stdout` and `stderr`; **`.nothrow()`** resolves instead. `.cwd(dir)` and `.env({...})` set where and with what it runs.

## In the playground

The shell runs Bun's builtins over the project's files: `echo`, `cd`, `pwd`, `ls`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `cp`, `which`, `export`, `seq`, `yes`, `dirname`, `basename`, `true`, `false` and `exit`. Other programs (`git`, `grep`, `node`) aren't found, because a browser has no processes. The console below the preview is the same shell, so you can type `ls notes` or `cat notes/todo.txt` there after a run. See [Bun APIs](/compatibility/bun/) for the details.
