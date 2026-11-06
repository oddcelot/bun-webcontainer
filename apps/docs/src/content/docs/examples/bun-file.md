---
title: "Bun.file and Bun.write example: read and write files"
description: "Write text and JSON with Bun.write, read them back with Bun.file, and check a file's size and type, in a runnable example in your browser."
sidebar:
  order: 5
  label: Bun.file and Bun.write
---

`Bun.write` writes strings, JSON, blobs or responses to a file, and `Bun.file` gives you a lazy handle to read one. Press **Run**; the files land in the project, in your browser.

```ts playground
await Bun.write("notes.txt", "Bun runs in the browser.\n");
await Bun.write("data.json", JSON.stringify({ visits: 1, tags: ["bun", "wasm"] }, null, 2));

const notes = Bun.file("notes.txt");
console.log(await notes.text());
console.log(notes.size, "bytes,", notes.type);

const data = await Bun.file("data.json").json();
data.visits++;
await Bun.write("data.json", JSON.stringify(data, null, 2));
console.log(await Bun.file("data.json").json());

console.log(await Bun.file("missing.txt").exists());
```

## How it works

- **`Bun.write(path, data)`** creates or replaces the file and resolves to the number of bytes written. `data` can be a string, a `Blob`, an `ArrayBuffer`, a `Response` or another `Bun.file`.
- **`Bun.file(path)`** doesn't read anything yet: it's a `Blob` that reads the file when you call `.text()`, `.json()`, `.bytes()` or `.stream()`.
- **`.size`** and **`.type`** come from the file and its extension (`text/plain;charset=utf-8` for `.txt`).
- **`.exists()`** tells you whether the file is there, instead of catching an error.

## In the playground

Files live in the project's virtual file system and are saved in your browser, so `notes.txt` and `data.json` show up in the file tree when you open the example in the full playground. File descriptors aren't supported; see [Bun APIs](/compatibility/bun/) for the details.
