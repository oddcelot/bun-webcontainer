---
title: Storage and persistence
description: Where your projects are saved and how long they stay.
sidebar:
  order: 2
---

Projects are saved to the browser's [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) as you edit. `node_modules` and `.git` are not saved; `bun install` restores them.

The playground asks the browser to keep its storage persistent. Browsers may still clear site data, so use a share link to keep a copy of a project.
