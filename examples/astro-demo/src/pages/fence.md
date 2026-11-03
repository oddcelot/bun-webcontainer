---
layout: ../Layout.astro
title: A fence
---

A ` ```ts playground ` fence in Markdown is the same block as `<Code playground>`:

```ts playground title="index.ts"
console.log("Hello from a fence");
```

A fence without `playground` is left to Astro's own highlighter:

```ts
const plain = true;
```
