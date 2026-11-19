// node apps/playground/src/previewInject.test.ts   (node >= 26 runs the TypeScript directly)
import assert from "node:assert/strict";
import { injectionPoint, injectScripts, injectScriptsInStream } from "./previewInject.ts";

const S = "<script>1</script>";

// Whole documents.
for (const [html, want] of [
  ["<!doctype html><html lang=en><head><title>t</title></head><body>x", `<!doctype html><html lang=en><head>${S}<title>t</title></head><body>x`],
  ["<!DOCTYPE html>\n<html>\n<HEAD data-a='>'>x", `<!DOCTYPE html>\n<html>\n<HEAD data-a='>${S}'>x`],
  ["<!doctype html><title>t</title><p>x", `<!doctype html>${S}<title>t</title><p>x`],
  ["<!-- a <head> in a comment --><html><body>x", `<!-- a <head> in a comment --><html>${S}<body>x`],
  ["<header>x</header>", `${S}<header>x</header>`],
  ["just text", `${S}just text`],
  ["", S],
  ["<html _hk=1 lang=en><head><meta charset=utf-8>", `<html _hk=1 lang=en><head>${S}<meta charset=utf-8>`],
]) assert.equal(injectScripts(html, S), want);

// Undecided while the start could still become one of the tags.
for (const partial of ["", "  ", "<", "<!doc", "<!doctype html", "<!doctype html>", "<!doctype html><ht", "<html><hea", "<html><head", "<html><head lang", "<!-- open"])
  assert.equal(injectionPoint(partial), null, JSON.stringify(partial));
for (const [partial, at] of [["<html><head>", 12], ["<!doctype html><body", 15], ["<!doctype html>hello", 15], ["<html><header", 6], ["hello", 0]] as const)
  assert.equal(injectionPoint(partial), at, JSON.stringify(partial));
// A comment that never ends doesn't hold the page back for ever.
assert.equal(injectionPoint(`<!--${"x".repeat(70000)}`), 0);

// Streams: the same result however the bytes are cut, and what follows the point isn't held back.
const enc = new TextEncoder();
const streamOf = (chunks: Uint8Array[], gate?: Promise<void>) =>
  new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!chunks.length) return c.close();
      if (chunks.length === 1 && gate) await gate;
      c.enqueue(chunks.shift()!);
    },
  });
const html = "<!doctype html><html><head><title>é€</title></head><body><p>ünïcödé</p></body></html>";
const bytes = enc.encode(html);
for (const size of [1, 2, 3, 7, 16, 1000]) {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  assert.equal(await new Response(injectScriptsInStream(streamOf(chunks), S)).text(), injectScripts(html, S), `chunks of ${size}`);
}
assert.equal(await new Response(injectScriptsInStream(streamOf([]), S)).text(), S);
assert.equal(await new Response(injectScriptsInStream(streamOf([enc.encode("<!doctype html>")]), S)).text(), `<!doctype html>${S}`);

{
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reader = injectScriptsInStream(streamOf([enc.encode("<html><head><title>t</title>"), enc.encode("<p>late</p>")], gate), S).getReader();
  let early = "";
  // The head and the scripts come before the server's second chunk exists.
  while (!early.includes("<title>")) early += new TextDecoder().decode((await reader.read()).value);
  assert.equal(early, `<html><head>${S}<title>t</title>`);
  open();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  assert.equal(rest, "<p>late</p>");
}

// An error after the point reaches the reader; cancelling reaches the source.
{
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(enc.encode("<html><head>")),
    cancel: (reason) => void (cancelled = reason),
  });
  const reader = injectScriptsInStream(source, S).getReader();
  await reader.read();
  await reader.cancel("gone");
  assert.equal(cancelled, "gone");
  const failing = new ReadableStream<Uint8Array>({
    start: (c) => c.enqueue(enc.encode("<html><head>x")),
    pull: () => Promise.reject(new Error("boom")),
  });
  await assert.rejects(new Response(injectScriptsInStream(failing, S)).text(), /boom/);
}

console.log("previewInject: ok");
