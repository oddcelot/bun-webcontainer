---
title: Astro
description: Runnable code blocks in an Astro site with @runbun/astro.
sidebar:
  order: 6
---

`@runbun/astro` adds code blocks to an Astro 7 site that are highlighted at build time with [@pierre/highlights](https://diffs.com/highlights) and turn into a live [embed](/guides/embedding/) when a reader clicks Run. Until then a block is plain HTML: no script runs and nothing downloads.

```sh
bun add @runbun/astro
```

## Set up

Add the integration, and the remark plugin if you want runnable fences in Markdown:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";

export default defineConfig({
  integrations: [runbun()],
  markdown: { processor: unified({ remarkPlugins: [remarkRunbun] }) },
});
```

## Code blocks

In `.mdx` or `.astro` files, `<Code>` renders a static block. `playground` adds the Run button, and the block takes every embed option (`mode`, `features`, `files`, `readonly`, `persist`, `expand`, …). `title` names the file:

```mdx
import { Code } from "@runbun/astro/components";

<Code lang="ts" title="index.ts" code={`console.log(Bun.version);`} />
<Code playground mode="code" features="console" title="index.ts" code={`console.log(Bun.version);`} />
```

`<Playground>` is the embed on its own: `files` are its sources, and its children are the poster shown until it starts.

## Fences

With the remark plugin, a fence marked `playground` becomes a runnable block, and fences with the same `group=<name>` become one embed with several files:

````md
```ts playground group=demo title="index.ts"
import { greet } from "./greet";
console.log(greet("Bun"));
```

```ts playground group=demo title="greet.ts"
export const greet = (name: string) => `Hello, ${name}`;
```
````

The meta also takes `mode`, `features`, `load`, `height`, `autorun`, `readonly`, `persist`, `theme`, `file` and `expand` (`expand=false` leaves the modal button out). Fences without `playground` stay as they were.

## Options

| Option | Default | |
| --- | --- | --- |
| `playgroundUrl` | `https://runbun.dev/` | Where the embeds come from. |
| `themes` | `["pierre-light", "pierre-dark"]` | The code themes: names of highlights' bundled themes, or Zed or VS Code theme objects. |
| `themeSelector` | | The CSS selector each theme goes under, for a site with its own theme switch, e.g. ``({ name }) => `:root[data-code-theme='${name}']` ``. Without it the first light theme applies, and the first dark one under `prefers-color-scheme: dark`. |
| `sync` | | `{ scheme, family }`: the `<html>` attributes that hold the page's scheme (`light` or `dark`) and theme family, for the embeds to follow. Without it embeds follow the OS. |

The blocks' look comes from CSS properties you can set: `--runbun-code-border`, `--runbun-code-radius`, `--runbun-code-font`, `--runbun-code-size`, `--runbun-code-caption-size` and `--runbun-code-line-height`. Blocks carry Starlight's `not-content` class, so they work in Starlight pages as they are.
