# @runbun/astro

Code blocks for Astro 7, highlighted at build time with [@pierre/highlights](https://diffs.com/highlights), that turn
into a runnable Bun playground ([runbun.dev](https://runbun.dev)) when a reader clicks Run.

```sh
bun add @runbun/astro
```

```js
// astro.config.mjs
import { unified } from "@astrojs/markdown-remark";
import runbun from "@runbun/astro";
import remarkRunbun from "@runbun/astro/remark";

export default defineConfig({
  integrations: [runbun()],
  markdown: { processor: unified({ remarkPlugins: [remarkRunbun] }) },
});
```

```mdx
import { Code } from "@runbun/astro/components";

<Code lang="ts" title="index.ts" code={`console.log(Bun.version);`} />
<Code playground mode="code" title="index.ts" code={`console.log(Bun.version);`} />
```

In Markdown, a ` ```ts playground ` fence does the same. Options, themes and fences:
[docs.runbun.dev/guides/astro](https://docs.runbun.dev/guides/astro/).

The package is MIT-licensed (see LICENSE). The playground it embeds is a hosted service at runbun.dev with its own terms.

runbun is an independent project, not affiliated with or endorsed by Oven or Bun.
