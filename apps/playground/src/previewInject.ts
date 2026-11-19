// Where the service worker puts its scripts in a preview page (sw.ts servePreview), decided from the start of
// the document so a streamed page keeps streaming: the scripts go in as soon as the place is known, and the rest of
// the body passes through as the server sends it. No imports: node runs the test on this file as it is.

/** What may come before the place: whitespace, the doctype, comments, `<html>`; then `<head>` itself, if it is next. */
const LEAD = /^(?:\s+|<!doctype[^>]*>|<!--[\s\S]*?-->|<html\b[^>]*>)*(?:<head\b[^>]*>)?/i;
/** The start of something LEAD would take once the rest of it has come. */
const UNFINISHED = /^<(?:!doctype|!--|html\b|head\b)/i;
const OPENINGS = ["<!doctype", "<!--", "<html", "<head"];
/** How much of a page is held back at most while its start can't be told yet (a long comment). */
const HOLD = 65536;

/**
 * The offset in `html` (the document's start) for the scripts: right after `<head>` when the document opens with
 * one, else after its doctype, comments and `<html>`, where the parser puts them in the head it makes up. Null while
 * `html` may be too short to tell (it ends inside one of these); `whole` says there is no more to come.
 */
export function injectionPoint(html: string, whole = false): number | null {
  const at = LEAD.exec(html)![0].length;
  if (whole || /<head\b[^>]*>$/i.test(html.slice(0, at)) || html.length >= HOLD) return at;
  const rest = html.slice(at);
  // Nothing yet, `<he` (could still become `<head>`), or one of them without its end.
  const start = rest.toLowerCase();
  return OPENINGS.some((o) => o.startsWith(start)) || UNFINISHED.test(rest) ? null : at;
}

/** `html` with `script` at its injection point. */
export const injectScripts = (html: string, script: string) => {
  const at = injectionPoint(html, true)!;
  return html.slice(0, at) + script + html.slice(at);
};

/** The stream with `script` at its injection point; what follows the point passes through chunk by chunk. */
export function injectScriptsInStream(stream: ReadableStream<Uint8Array>, script: string): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  // One character per byte, so an offset in the text is one in the bytes (the tags looked for are ASCII).
  const latin1 = new TextDecoder("latin1");
  let held: Uint8Array | undefined = new Uint8Array(0);
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      for (;;) {
        const { done, value } = await reader.read();
        if (!held) return done ? c.close() : c.enqueue(value);
        if (value) {
          const next = new Uint8Array(held.length + value.length);
          next.set(held);
          next.set(value, held.length);
          held = next;
        }
        const at = injectionPoint(latin1.decode(held), done);
        if (at === null) continue;
        c.enqueue(held.slice(0, at));
        c.enqueue(new TextEncoder().encode(script));
        if (at < held.length) c.enqueue(held.slice(at));
        held = undefined;
        return done ? c.close() : undefined;
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
