---
title: Storage and persistence
description: Where your projects are saved and how long they stay.
sidebar:
  order: 3
---

Each project is saved to the browser's [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) a moment after you stop typing, and when you switch away from the tab. The demo, every example, every GitHub repo and every share link is its own project with its own saved copy.

- `node_modules` and `.git` aren't saved; dependencies are installed again when you open the project.
- `bun:sqlite` file databases are saved with the project.
- When you reopen a project, your saved files win over its source. `reset` in the console throws them away.
- Only one tab saves a project. A second tab with the same project warns that its changes won't be kept.
- If the browser has no Origin Private File System, the playground warns that nothing will be kept across reloads.

## How long it stays

The playground asks the browser to keep its storage (`navigator.storage.persist()`). Browsers can still clear it, for example when the disk is nearly full or when you clear site data. To keep a copy of a project, use a share link or push it to GitHub.
