# @runbun/embed

`<bun-playground>`: a custom element that embeds a runnable Bun playground ([runbun.dev](https://runbun.dev)) in any
page. The code runs in the reader's browser, not on a server.

```sh
bun add @runbun/embed
```

```js
import "@runbun/embed";
```

```html
<bun-playground mode="code">
  <script type="text/plain" data-file="index.ts">
    console.log("hello from Bun");
  </script>
</bun-playground>
```

Without a bundler, load the same element from runbun.dev instead:
`<script type="module" src="https://runbun.dev/embed.js"></script>`.

- `@runbun/embed` registers the elements, framing `https://runbun.dev/`.
- `@runbun/embed/element` exports `BunPlayground`, `BunPlaygroundDefaults` and `define({ src })` without registering,
  to frame another playground (a local dev server, a self-hosted deploy).
- `@runbun/embed/protocol` has the types of the postMessage protocol, for talking to the `/embed` iframe yourself.

Your own examples: `<bun-playground library="/examples.json">` gives the embed a gallery of your projects, and
`npx @runbun/embed pack ./examples --out examples.json` builds that file from a folder of projects (one per folder,
each with its name in a `runbun.json` or an `example.json`, as in [runbun-examples](https://github.com/oddcelot/runbun-examples)).

Modes, features, attributes, methods and events: [docs.runbun.dev/guides/embedding](https://docs.runbun.dev/guides/embedding/)
and the [embed reference](https://docs.runbun.dev/reference/embed-api/).

The package is MIT-licensed (see LICENSE). The playground it embeds is a hosted service at runbun.dev with its own terms.

runbun is an independent project, not affiliated with or endorsed by Oven or Bun.
