---
title: Privacy
description: What runbun.dev and docs.runbun.dev store, send and keep.
---

The playground (runbun.dev) and these docs (docs.runbun.dev) set **no cookies** of their own and run **no analytics or tracking**. Cookies that an app you run in the playground sets are the app's: they stay in your browser, under runbun.dev's `/__preview/` path (see [below](#in-your-browser)).

## In your browser

Your projects stay in your browser. The playground keeps them there and sends none of it to us:

- **Projects** in the browser's Origin Private File System (see [Storage and persistence](/guides/storage/)).
- **Settings** (theme, keyboard shortcuts, auto-save, panel layout) in local storage.
- **The current tab's session** in session storage.
- **Folders you open from disk**: the handle, so the playground can reopen the folder; the browser asks for permission again.
- **Transpiled modules** in a cache, so the next run starts faster.
- **npm packages** you installed, in a cache shared by your projects, so they aren't downloaded again, and their large files unpacked (`bun pm cache rm` clears both).
- **Your apps' cookies**: cookies a program you run sets (with `Set-Cookie`, or a page's `document.cookie`) are stored by your browser for runbun.dev under `/__preview/`, as a real host would store them; HttpOnly ones are kept in the page's memory instead. `cookies clear` in the console deletes them. Nothing reads them but your app.
- **A service worker** that serves your project's files and its `Bun.serve` preview to the page, and keeps a copy of the playground's own files in your browser so it opens again without downloading them.

Clearing the site's data in your browser removes all of it.

## Share links

- **A normal share link** (`runbun.dev/#code=…`) carries the project in the part of the URL after `#`. Browsers don't send that part to the server, so nothing is uploaded.
- **A short link** (`runbun.dev/s/…`) is only made when you pick **Copy short link**, or attach the project to [feedback](#feedback). It stores a copy of the project on runbun.dev (Cloudflare Workers KV), and **anyone with the link can open it**. Files that may hold secrets (`.env`, keys, `.npmrc`) and binary files are left out. Next to the copy we keep the day it was created and the day it was last opened, and nothing about who made it.

Short links are kept until they're removed. To have one removed, email [privacy@runbun.dev](mailto:privacy@runbun.dev) with the link. The same address takes reports of illegal content and requests about personal data.

## Feedback

**Feedback** in the playground's status bar sends what you write to runbun.dev (a Cloudflare D1 database, apart from short links), with the time and the page's address (without the part after `#`). Only if you add them does it carry:

- **an email address**, used only to answer you;
- **the Bun release and your browser** (its user agent, window size and pixel ratio, and any feature the playground found missing); the form lists exactly what is sent;
- **the open project**, as a [short link](#share-links) (stored like any other, secrets left out), or, while it is an unchanged example or repository, just its name.

**Was this page helpful?** at the bottom of each docs page sends your answer and the page's address the same way, and a comment and email address only if you write them.

Your IP address is used to limit how much feedback can be sent a minute; it isn't stored. Feedback is kept until we've dealt with it. To have something you sent removed, email [privacy@runbun.dev](mailto:privacy@runbun.dev).

## Requests from your browser

- **runbun.dev / docs.runbun.dev** are hosted on Cloudflare, which processes requests (including your IP address) to serve and protect the sites; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/). When you make a short link, your IP address is used to limit how many you can make a minute; it isn't stored.
- **npm**: installing packages fetches them from `registry.npmjs.org` ([npm's privacy policy](https://docs.npmjs.com/policies/privacy)).
- **GitHub**: opening a repository fetches it from `api.github.com` and `raw.githubusercontent.com` ([GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).

These requests go straight from your browser to those services, and only when you install or import something.

## Changes

If this changes, for example if the sites add analytics, this page will say so first.
