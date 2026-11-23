# runbun

**Bun in the browser.** [runbun.dev](https://runbun.dev) is a playground that runs Bun projects in a browser tab: no
server, no install. It's built from Bun's own Rust crates (transpiler, bundler, resolver, `bun fmt`) compiled to
WebAssembly, with `Bun.*`, `bun:*` and `node:*` shimmed in JavaScript.

- **Run real projects:** `Bun.serve` with a live preview, `bun install` from npm, `bun test`, `bun:sqlite`, `Bun.$`,
  and frameworks such as Elysia, Hono, Vite, Astro and Solid.
- **Share them:** a link opens the project, ready to run.
- **Embed them:** put runnable code blocks in your docs or blog.

Docs: [docs.runbun.dev](https://docs.runbun.dev) · [What works](https://docs.runbun.dev/compatibility/) ·
[Changelog](./CHANGELOG.md)

## Browsers

Code needs WebAssembly Memory64, which Chrome and Edge 133+ and Firefox 134+ have. Safari can open and edit projects,
but can't run them yet. See [browser support](https://docs.runbun.dev/compatibility/browsers/).

## Packages

| Package | What |
| --- | --- |
| [`@runbun/embed`](./packages/embed) | `<bun-playground>`: a custom element that embeds a runnable playground in any page |
| [`@runbun/astro`](./packages/astro) | An Astro integration: code blocks that turn into a playground on click |
| [`@runbun/connect`](./packages/connect) | Runs playground code with the real Bun on your machine, sandboxed |

To host the playground yourself, download the archive attached to each
[release](https://github.com/oddcelot/bun-webcontainer/releases), as
[self-hosting](https://docs.runbun.dev/guides/self-hosting/) explains.

## Contributing

Bug reports with a share link help most: [open an issue](https://github.com/oddcelot/bun-webcontainer/issues/new/choose).
To build it and send changes, read [CONTRIBUTING.md](./CONTRIBUTING.md). Gallery examples live in
[runbun-examples](https://github.com/oddcelot/runbun-examples).

## Sponsor

runbun is free and follows every Bun release. If it's useful to you, please consider
[sponsoring](https://github.com/sponsors/oddcelot).

## License

The npm packages (`@runbun/embed`, `@runbun/astro`, `@runbun/connect`) are [MIT](./packages/embed/LICENSE): embed
the playground anywhere.

Everything else is [FSL-1.1-MIT](./LICENSE.md), the [Functional Source License](https://fsl.software). Use it, change
it, self-host it for yourself, your team or your open source project. What it doesn't allow is offering it, or
something built from it, as a competing commercial product. Each release becomes MIT two years after it came out.

Not covered by it: code from other projects keeps its license. That includes Bun's own code (which `patches/bun/` changes; it stays MIT), the
vendored `packages/astro-solid*` and `crates/git-wasm/patched/`, and the projects bundled into the playground. The
runbun name isn't licensed for use by other products.

runbun is an independent project, not affiliated with or endorsed by Oven or Bun. Bun's name and logo belong to their
owners.
