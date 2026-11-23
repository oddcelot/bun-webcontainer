# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/oddcelot/bun-webcontainer/security/advisories/new) (the repository's
Security tab). Include what an attacker can do, and the steps or a shared project that shows it.

You'll get an answer within a week. Once a fix is out, the advisory is published, with credit if you want it.

## What counts

The playground runs code that anyone can share, so the boundaries around that code are what matter most:

- **runbun.dev and its embeds**: a shared or embedded project reaching the editor's origin, another project's files,
  the GitHub sign-in, or the page that embeds it (`<bun-playground>`, `@runbun/astro`).
- **Share links and the Worker** (`apps/playground/worker/`): reading or changing someone else's shared project, or
  anything that gets at stored data or tokens.
- **`@runbun/connect`**, the local runner: a web page, or a project's code, getting past its access checks or approval
  prompt, or out of its sandbox onto your machine. See its [NOTES.md](./packages/connect/NOTES.md) for what it
  promises.
- **The self-hosting archive**: a default in it that leaves a copy open to one of the above.

Bugs where code inside the playground behaves differently from native Bun are not security issues. Please
[open an issue](https://github.com/oddcelot/bun-webcontainer/issues/new/choose) for those.

## Supported versions

Only the latest release of runbun (runbun.dev runs it) and the latest version of each npm package (`@runbun/astro`,
`@runbun/connect`, `@runbun/embed`) get fixes.
