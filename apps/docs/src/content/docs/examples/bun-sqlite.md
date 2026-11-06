---
title: "bun:sqlite example: an in-memory SQLite database"
description: "Create a table, insert rows with prepared statements and query them with bun:sqlite, Bun's built-in SQLite driver, running in your browser."
sidebar:
  order: 4
  label: bun:sqlite
---

Bun ships a SQLite driver as `bun:sqlite`: no package to install. Press **Run** to create a database, fill it and query it; the output shows in the console.

```ts playground
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0)");

const insert = db.prepare("INSERT INTO todos (title) VALUES (?)");
const insertAll = db.transaction((titles: string[]) => {
  for (const title of titles) insert.run(title);
});
insertAll(["Write the docs", "Ship it", "Celebrate"]);

db.run("UPDATE todos SET done = 1 WHERE id = ?", [1]);

const open = db.query("SELECT id, title FROM todos WHERE done = 0").all();
console.log("Still to do:", open);
console.log(db.query("SELECT count(*) AS total FROM todos").get());
```

## How it works

- **`new Database(":memory:")`** opens a database that lives only as long as the program. Pass a file name instead, such as `"app.db"`, to keep it in a file.
- **`db.prepare(sql)`** compiles a statement once; **`.run(...params)`** executes it with `?` placeholders filled in, which keeps values out of the SQL string.
- **`db.transaction(fn)`** wraps a function so all its writes commit together, or none do if it throws. It's also much faster than separate inserts.
- **`db.query(sql)`** returns a cached statement; **`.all()`** gives every row as an object, **`.get()`** the first one.

## In the playground

`bun:sqlite` here is built on [sql.js](https://sql.js.org/), SQLite compiled to WebAssembly. A file database is saved in the project, so it's still there after a reload. A few APIs are missing; [Bun APIs](/compatibility/bun/) lists them.
