---
title: Storage and persistence
description: Where your projects are saved and how long they stay.
sidebar:
  order: 3
---

Each project is saved to the browser's [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) a moment after you stop typing, and when you switch away from the tab. The demo, every example, every GitHub repo and every share link is its own project with its own saved copy.

- `node_modules` and `.git` aren't saved; dependencies are installed again when you open the project, from the package cache shared by all projects (`bun pm cache`), so packages you installed before aren't downloaded again.
- `bun:sqlite` file databases are saved with the project.
- When you reopen a project, your saved files win over its source. `reset` in the console throws them away.
- Only one tab saves a project. A second tab with the same project warns that its changes won't be kept.
- If the browser has no Origin Private File System, the playground warns that nothing will be kept across reloads.

After one visit the playground also opens offline: the service worker keeps its files, and a new version downloads only the files that changed.

## How long it stays

The playground asks the browser to keep its storage (`navigator.storage.persist()`). In Chrome, projects sit in their own [storage bucket](https://developer.chrome.com/docs/web-platform/storage-buckets), kept apart from other site data. Other browsers keep projects and caches together, so there the playground keeps its caches small: once the site's storage passes half of what the browser allows it (at most 1 GiB), the least recently used cache entries are deleted, never your projects. Browsers can still clear them, for example when the disk is nearly full or when you clear site data, and Safari clears a site's storage after seven days without a visit.

**Install the playground** to make its storage last longer: in Chrome or Edge, use the install button in the address bar; in Safari, File → Add to Dock (on iPhone and iPad, Share → Add to Home Screen). Safari doesn't apply the seven-day limit to web apps added this way.

To keep a copy of a project, use **Download as zip** in the Share menu and open it again with **Zip file…** in the project picker. A share link or a push to GitHub works too.
