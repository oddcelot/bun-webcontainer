// HTMLRewriter cases, most of them from bun/test/js/workerd/html-rewriter.test.js, written to give the same JSON on any
// engine: gen-expected.ts runs them on native Bun (expected.json), test.ts on the wasm under the playground's host
// (src/worker/htmlRewriter.ts), apps/playground/scripts/htmlrewriter.ts in the playground's worker.
// A case returns a JSON value, or throws: the runner records the error's class, name and message.

type Rewriter = {
  on(selector: string, handlers: object): Rewriter;
  onDocument(handlers: object): Rewriter;
  transform(input: unknown): unknown;
};
type HTMLRewriterClass = { new (): Rewriter };
type Case = [name: string, run: (HTMLRewriter: HTMLRewriterClass) => unknown];

const tick = () => new Promise<void>((r) => setTimeout(r, 2));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (res: unknown) => (res as Response).text();
/** A body that arrives in the given pieces. */
const pieces = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(bytes(p));
      c.close();
    },
  });
const inner = (selector: string, input: string, content = "new") => (R: HTMLRewriterClass) =>
  text(new R().on(selector, { element: (e: any) => void e.setInnerContent(content) }).transform(new Response(input)));

export const cases: Case[] = [
  // Inputs and what comes back
  ["input: string returns a string", (R) => [typeof new R().on("p", { element: (e: any) => e.setAttribute("a", "1") }).transform("<p>x</p>"), new R().on("p", { element: (e: any) => e.setAttribute("a", "1") }).transform("<p>x</p>")]],
  ["input: ArrayBuffer returns an ArrayBuffer", (R) => {
    const out = new R().on("p", { element: (e: any) => e.setInnerContent("y") }).transform(bytes("<p>x</p>").buffer);
    return [out instanceof ArrayBuffer, new TextDecoder().decode(out as ArrayBuffer)];
  }],
  ["input: Uint8Array returns an ArrayBuffer", (R) => {
    const out = new R().on("p", { element: (e: any) => e.setInnerContent("y") }).transform(bytes("<p>x</p>"));
    return [out instanceof ArrayBuffer, new TextDecoder().decode(out as ArrayBuffer)];
  }],
  ["input: DataView returns an ArrayBuffer (byteOffset and byteLength honoured)", (R) => {
    const html = bytes("<p>x</p>");
    const buf = new ArrayBuffer(4 + html.length + 4);
    new Uint8Array(buf).fill(60);
    new Uint8Array(buf, 4, html.length).set(html);
    const out = new R().on("p", { element: (e: any) => void e.setInnerContent("y") }).transform(new DataView(buf, 4, html.length));
    return [out instanceof ArrayBuffer, new TextDecoder().decode(out as ArrayBuffer)];
  }],
  ["input: Blob is not accepted", (R) => new R().transform(new Blob(["<p>x</p>"]))],
  ["input: number is not accepted", (R) => new R().transform(5)],
  ["input: Symbol is not accepted", (R) => new R().transform(Symbol("ok"))],
  ["input: no argument", (R) => (new R() as any).transform()],
  ["input: Response keeps status and headers", async (R) => {
    const res = new R().on("p", { element: (e: any) => e.setAttribute("a", "1") }).transform(new Response("<p>x</p>", { status: 201, statusText: "Made", headers: { "x-y": "z", "content-type": "text/html" } })) as Response;
    return [res.status, res.statusText, res.headers.get("x-y"), res.headers.get("content-type"), await res.text()];
  }],
  ["input: Response body is used, a second transform throws", async (R) => {
    const res = new Response("<p>x</p>");
    const rw = new R().on("p", { element() {} });
    await text(rw.transform(res));
    try {
      rw.transform(res);
    } catch (e: any) {
      return [res.bodyUsed, e.constructor.name, e.message];
    }
  }],
  ["input: empty body", async (R) => JSON.stringify(await text(new R().on("p", { element: (e: any) => e.remove() }).transform(new Response(null))))],
  ["input: chunks split inside a tag and a text", async (R) =>
    text(new R().on("p", { element: (e: any) => e.setAttribute("a", "1") }).transform(new Response(pieces("<p", ">x</p><p>y</", "p>"))))],
  ["input: a token spanning many chunks", async (R) =>
    text(new R().on("a", { element: (e: any) => e.setAttribute("n", e.getAttribute("href")) }).transform(new Response(pieces("<a hre", "f=", '"https://exa', "mple.com/", 'x">link</a>'))))],

  // Handlers
  ["handlers: element class instance as the handler object", async (R) => {
    class Handler {
      content: string;
      constructor(content: string) {
        this.content = content;
      }
      element(e: any) {
        e.setInnerContent(this.content);
      }
    }
    return text(new R().on("p", new Handler("new")).transform(new Response("<p>test</p>")));
  }],
  ["handlers: this is the handler object", (R) => {
    const h = { seen: undefined as unknown, element(this: any) { this.seen = this === h; } };
    new R().on("p", h).transform("<p>x</p>");
    return h.seen;
  }],
  ["handlers: element must be a function", (R) => new R().on("p", { element: null }) as unknown],
  ["handlers: element of a number", (R) => new R().on("p", { element: 5 }) as unknown],
  ["handlers: on without handlers", (R) => new R().on("p", undefined as never) as unknown],
  ["handlers: on with one argument", (R) => (new R() as any).on("p")],
  ["handlers: on without selector", (R) => new R().on(undefined as never, {}) as unknown],
  ["handlers: onDocument of a number", (R) => new R().onDocument(5 as never) as unknown],
  ["handlers: invalid selector", (R) => new R().on("p >", {}) as unknown],
  ["handlers: invalid selector name", (R) => {
    try {
      new R().on("p[", { element() {} });
    } catch (e: any) {
      return [e.constructor.name, e.name];
    }
  }],
  ["handlers: a handler that throws, string input", (R) => new R().on("p", { element() { throw new Error("test"); } }).transform("<p>x</p>")],
  ["handlers: a handler that throws rejects the body", async (R) => text(new R().on("p", { element() { throw new Error("test"); } }).transform(new Response("<p>x</p>")))],
  ["handlers: a handler that returns an Error rejects the body", async (R) => text(new R().on("p", { element: () => new Error("returned, not thrown") }).transform(new Response("<p>x</p>")))],
  ["handlers: later handlers do not run after a throw", (R) => {
    const ran: string[] = [];
    try {
      new R().on("p", { element() { ran.push("a"); throw new Error("x"); } }).on("p", { element() { ran.push("b"); } }).transform("<p>1</p><p>2</p>");
    } catch {}
    return ran;
  }],
  ["handlers: registrations apply to every transform", (R) => {
    const rw = new R().on("p", { element: (e: any) => void e.setAttribute("a", "1") });
    return [rw.transform("<p>x</p>"), rw.transform("<p>y</p>")];
  }],
  ["handlers: on() inside a handler applies to the next transform", (R) => {
    const rw = new R();
    let grown = false;
    rw.on("div", {
      element(el: any) {
        el.setInnerContent("div");
        if (!grown) {
          grown = true;
          for (let i = 0; i < 8; i++) rw.on("span", { element: (s: any) => void s.setAttribute("n", String(i)) });
        }
      },
    });
    rw.on("span", { element: (el: any) => void el.setInnerContent("span") });
    const input = "<div>1</div><span>2</span><div>3</div><span>4</span>";
    return [rw.transform(input), rw.transform(input)];
  }],
  ["handlers: each selector keeps its own handlers, also after a rejected on()", (R) => {
    const rw = new R();
    const count = 12;
    for (let i = 0; i < count; i++) {
      if (i === count / 2) {
        try { rw.on("p[", { element() {} }); } catch {}
        try { rw.on(`p[data-i="${i}"]`, { element: "not a function" } as never); } catch {}
      }
      if (i % 2 === 0) rw.on(`p[data-i="${i}"]`, { element: (el: any) => void el.setInnerContent(`element ${i}`) });
      else rw.on(`p[data-i="${i}"]`, { text(chunk: any) { if (chunk.text) chunk.replace(`text ${i}`); } });
    }
    return rw.transform(Array.from({ length: count }, (_, i) => `<p data-i="${count - 1 - i}">x</p>`).join(""));
  }],
  ["handlers: a selector nested too deeply", (R) => {
    const nested = (open: string, depth: number) => open.repeat(depth) + "b" + ")".repeat(depth);
    const out: unknown[] = [];
    for (const open of [":not(", ":not(/*)*/", ":not(.a\\)", `:not([a=")"]`, `:not([a='\\')']`]) {
      try { new R().on(nested(open, 100), {}); out.push("ok"); } catch (e: any) { out.push(e.message); }
    }
    try { new R().on(nested(":not(", 32), {}); out.push("ok"); } catch (e: any) { out.push(e.message); }
    return out;
  }],

  // Async handlers (a Response input waits for them)
  ["async: replacement after a timer", async (R) => text(new R().on("div", { async element(e: any) { await tick(); e.replace("<span>replace</span>", { html: true }); } }).transform(new Response("<div>x</div>")))],
  ["async: mutations before and after the await", async (R) => text(new R().on("div", { async element(e: any) { e.setAttribute("before", "1"); await tick(); e.setAttribute("after", "2"); e.setAttribute("id", "x"); } }).transform(new Response("<div>inner</div>")))],
  ["async: handlers run in document order", async (R) => {
    const log: string[] = [];
    const out = await text(new R().on("i", { async element(e: any) { const id = e.getAttribute("id"); log.push(`start ${id}`); await tick(); log.push(`end ${id}`); e.setInnerContent(id); } }).transform(new Response('<i id="0"></i><i id="1"></i><i id="2"></i>')));
    return [out, log];
  }],
  ["async: an attribute iterator from before the await keeps working", async (R) => {
    const seen: unknown[] = [];
    const out = await text(new R().on("div", { async element(e: any) { const it = e.attributes; seen.push(it.next().value); await tick(); seen.push(it.next().value, it.next().value, it.next().done); } }).transform(new Response('<div a="1" b="2" c="3">x</div>')));
    return [out, seen];
  }],
  ["async: the next handler for the same element runs after the previous one's await", async (R) => text(new R().on("div", { async element(e: any) { await tick(); e.setAttribute("a", ""); } }).on("div", { async element(e: any) { await tick(); e.setAttribute("b", ""); } }).transform(new Response("<div></div>")))],
  ["async: element removed after the await suppresses its content", async (R) => text(new R().on("div", { async element(e: any) { await tick(); e.remove(); } }).transform(new Response("a<div>dropped</div>b")))],
  ["async: text handler", async (R) => text(new R().on("div", { async text(c: any) { await tick(); if (c.text) c.replace(c.text.toUpperCase()); } }).transform(new Response("<div>hello</div>world")))],
  ["async: text handler on lastInTextNode", async (R) => text(new R().on("div", { async text(c: any) { await tick(); if (c.lastInTextNode) c.after("|"); } }).transform(new Response("<div>hello</div>")))],
  ["async: comments, doctype and document end handlers", async (R) => text(new R().onDocument({
    async doctype(d: any) { await tick(); d.remove(); },
    async comments(c: any) { await tick(); c.replace("[c]"); },
    async end(e: any) { await tick(); e.append("<!--end-->", { html: true }); },
  }).transform(new Response("<!DOCTYPE html><!--x-->body")))],
  ["async: onEndTag handler", async (R) => text(new R().on("p", { element(e: any) { e.onEndTag(async (t: any) => { await tick(); t.before("!"); }); } }).transform(new Response("<p>x</p>")))],
  ["async: onEndTag registered after an await", async (R) => text(new R().on("p", { async element(e: any) { await tick(); e.onEndTag((t: any) => void t.before("!")); } }).transform(new Response("<p>x</p>")))],
  ["async: rejection rejects the body", async (R) => text(new R().on("p", { async element() { await tick(); throw new Error("rej"); } }).transform(new Response("<p>x</p>")))],
  ["async: rejection with no real await", async (R) => text(new R().on("p", { async element() { throw new Error("rej2"); } }).transform(new Response("<p>x</p>")))],
  ["async: a microtask-only handler after a suspending one", async (R) => text(new R().on("p", { async element(e: any) { await tick(); e.setAttribute("a", "1"); } }).on("p", { async element(e: any) { await null; e.setAttribute("b", "2"); } }).transform(new Response("<p>x</p>")))],
  ["async: chunked input with async handlers", async (R) => text(new R().on("p", { async element(e: any) { await tick(); e.setAttribute("n", e.getAttribute("id")!); } }).transform(new Response(pieces('<p id="1">a</p><p', ' id="2">b</p><p id=', '"3">c</p>'))))],
  ["async: chained transforms", async (R) => {
    const first = new R().on("p", { async element(e: any) { await tick(); e.setAttribute("one", "1"); } }).transform(new Response("<p>x</p>"));
    return text(new R().on("p", { async element(e: any) { await tick(); e.setAttribute("two", "2"); } }).transform(first));
  }],
  // Bun gives up after a microtask checkpoint, the wasm host as soon as it sees a promise: the wording after the noun differs.
  ["async: string input with a handler that waits for a timer", (R) => {
    try { new R().on("p", { async element(e: any) { await tick(); e.setAttribute("a", "1"); } }).transform("<p>x</p>"); } catch (e: any) { return [e.constructor.name, e.message.slice(0, 66)]; }
  }],

  // Elements
  ["element: tagName, selfClosing, canHaveContent", async (R) => {
    const seen: Record<string, unknown> = {};
    await text(new R().on("*", { element(el: any) { seen[el.tagName] = [el.selfClosing, el.canHaveContent, el.namespaceURI]; } }).transform(new Response("<p>Lorem<br></p><div /><svg><circle /></svg>")));
    return seen;
  }],
  ["element: tagName renames the start and end tag", (R) => new R().on("p", { element(el: any) { el.tagName = "section"; } }).transform("<p>hi</p>")],
  ["element: tagName with a forbidden character", (R) => new R().on("p", { element(el: any) { el.tagName = "a b"; } }).transform("<p>")],
  ["element: attributes iterate in order", async (R) => {
    const seen: unknown[] = [];
    const out = await text(new R().on("div", { element(el: any) { for (const a of el.attributes) seen.push(a); } }).transform(new Response('<div first second="alrihgt" third="123" fourth=5 fifth=helloooo>hello</div>')));
    return [out, seen];
  }],
  ["element: attribute names are lowercased", (R) => {
    const seen: unknown[] = [];
    new R().on("div", { element(el: any) { seen.push([...el.attributes], el.getAttribute("DATA-X"), el.hasAttribute("Data-X")); } }).transform('<div DATA-X="1"></div>');
    return seen;
  }],
  ["element: attribute iterator is detached after the handler returns", async (R) => {
    let leaked: any, partial: any;
    const inside: unknown[] = [];
    await text(new R().on("div", { element(el: any) { leaked = el.attributes; for (const pair of el.attributes) inside.push(pair); partial = el.attributes; partial.next(); } }).transform(new Response('<div a="1" b="2" c="3"></div>')));
    return [inside, leaked.next(), partial.next(), [...leaked]];
  }],
  ["element: attribute iterator is detached when attributes are mutated", async (R) => {
    let afterSet: unknown, afterRemove: unknown, fresh: unknown;
    await text(new R().on("div", { element(el: any) { const it1 = el.attributes; el.setAttribute("x", "9"); afterSet = it1.next(); const it2 = el.attributes; el.removeAttribute("a"); afterRemove = it2.next(); fresh = [...el.attributes]; } }).transform(new Response('<div a="1" b="2" c="3"></div>')));
    return [afterSet, afterRemove, fresh];
  }],
  ["element: attribute iterator's Symbol.iterator", (R) => {
    let d: any;
    new R().on("p", { element(el: any) { d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el.attributes), Symbol.iterator); } }).transform("<p a=b></p>");
    const { value, ...rest } = d;
    return { name: value.name, length: value.length, ...rest };
  }],
  ["element: empty and absent attributes", (R) => {
    let got: unknown;
    new R().on("div", { element(el: any) { got = { explicitEmpty: el.getAttribute("a"), boolean: el.getAttribute("b"), valued: el.getAttribute("c"), absent: el.getAttribute("zzz"), has: [el.hasAttribute("a"), el.hasAttribute("b"), el.hasAttribute("zzz")] }; } }).transform('<div a="" b c="v">t</div>');
    return got;
  }],
  ["element: set and remove attributes", (R) => new R().on("div", { element(el: any) { el.setAttribute("x", ""); el.setAttribute("a", "new"); el.removeAttribute("b"); el.removeAttribute("none"); } }).transform('<div a="1" b="2" c="3">t</div>')],
  ["element: non-ASCII attribute values", (R) => {
    let got: unknown;
    new R().on("p", { element(el: any) { got = el.getAttribute("id"); el.setAttribute("title", "ž–日本"); } }).transform('<p id="Šžõäöü"></p>');
    return got;
  }],
  ["element: setAttribute with a forbidden name", (R) => new R().on("div", { element(el: any) { el.setAttribute("a b", "1"); } }).transform("<div>t</div>")],
  ["element: setAttribute with an empty name", (R) => new R().on("div", { element(el: any) { el.setAttribute("", "1"); } }).transform("<div>t</div>")],
  ["element: setAttribute failure leaves the element unchanged", (R) => {
    let after: unknown;
    const out = new R().on("div", { element(el: any) { try { el.setAttribute("a b", "1"); } catch {} after = [...el.attributes]; } }).transform('<div x="1">t</div>');
    return [after, out];
  }],
  ["element: prepend and append", (R) => new R().on("p", { element(el: any) { el.prepend("<span>prepend</span>"); el.prepend("<span>prepend html</span>", { html: true }); el.append("<span>append</span>"); el.append("<span>append html</span>", { html: true }); } }).transform("<p>test</p>")],
  ["element: before and after", (R) => new R().on("p", { element(el: any) { el.before("<b>b</b>"); el.before("<b>b</b>", { html: true }); el.after("<i>a</i>", { html: true }); el.after("<i>a</i>"); } }).transform("<p>test</p>")],
  ["element: replace", (R) => [new R().on("p", { element: (el: any) => void el.replace("<span>r</span>") }).transform("<p>test</p>!"), new R().on("p", { element: (el: any) => void el.replace("<span>r</span>", { html: true }) }).transform("<p>test</p>!")]],
  ["element: setInnerContent", (R) => [new R().on("p", { element: (el: any) => void el.setInnerContent("<span>replace</span>") }).transform("<p>test</p>"), new R().on("p", { element: (el: any) => void el.setInnerContent("<span>replace</span>", { html: true }) }).transform("<p>test</p>"), new R().on("p", { element: (el: any) => void el.setInnerContent("", { html: true }) }).transform("<p><span>test</span></p>")]],
  ["element: remove and removeAndKeepContent", (R) => [new R().on("p", { element: (el: any) => void el.remove() }).transform("a<p>test</p>b"), new R().on("p", { element: (el: any) => void el.removeAndKeepContent() }).transform("a<p>test</p>b"), new R().on("p", { element(el: any) { el.removeAndKeepContent(); } }).transform("<p><b>x</b></p>")]],
  ["element: removed", (R) => {
    const seen: unknown[] = [];
    new R().on("p", { element(el: any) { seen.push(el.removed); el.remove(); seen.push(el.removed); } }).transform("<p>x</p>");
    return seen;
  }],
  ["element: chained calls return the element", (R) => {
    let same: unknown;
    new R().on("p", { element(el: any) { same = el.setAttribute("a", "1") === el && el.before("x") === el && el.remove() === el; } }).transform("<p>x</p>");
    return same;
  }],
  ["element: a content argument that is not a string", (R) => new R().on("p", { element(el: any) { el.before(5); el.after({ toString: () => "obj" }); el.append(true as never); } }).transform("<p>x</p>")],
  ["element: before() without content", (R) => {
    try { new R().on("p", { element(el: any) { el.before(); } }).transform("<p>x</p>"); } catch (e: any) { return [e.constructor.name, e.code, e.message]; }
  }],
  ["element: onEndTag", (R) => new R().on("p", { element(el: any) { el.onEndTag((t: any) => { t.before("<!--"); t.after("-->"); }); } }).transform("<p>x</p>")],
  ["element: onEndTag name", (R) => [new R().on("p", { element(el: any) { el.onEndTag((t: any) => { t.name = "div"; }); } }).transform("<p>hi</p>"), new R().on("p", { element(el: any) { el.onEndTag((t: any) => { t.remove(); }); } }).transform("<p>hi</p>")]],
  ["element: a second onEndTag replaces the first", (R) => new R().on("p", { element(el: any) { el.onEndTag((t: any) => { t.name = "q"; t.after("A"); }); el.onEndTag((t: any) => { t.before("B"); }); } }).transform("<p>x</p>")],
  ["element: onEndTag from two handlers on one element", (R) => new R().on("p", { element(el: any) { el.onEndTag((t: any) => { t.before("1"); }); } }).on("p", { element(el: any) { el.onEndTag((t: any) => { t.before("2"); }); } }).transform("<p>x</p>")],
  ["element: onEndTag of a void element", (R) => new R().on("br", { element(el: any) { el.onEndTag(() => {}); } }).transform("<br>")],
  ["element: onEndTag with a non-function", (R) => {
    try { new R().on("div", { element(el: any) { el.onEndTag("nope"); } }).transform("<div>t</div>"); } catch (e: any) { return [e.constructor.name, e.message]; }
  }],

  // Detached units
  ["detached: a stashed element answers nothing", (R) => {
    let k: any;
    new R().on("p", { element(e: any) { k = e; } }).transform("<p>x</p>");
    return [k.tagName, k.removed, k.getAttribute("a"), k.hasAttribute("a"), k.attributes, k.setAttribute("a", "b"), k.before("x"), k.onEndTag(() => {}), k.remove(), k.selfClosing, k.namespaceURI];
  }],
  ["detached: setters do nothing and never coerce", (R) => {
    let el: any, end: any, comment: any;
    new R().on("p", { element(e: any) { el = e; e.onEndTag((t: any) => { end = t; }); }, comments(c: any) { comment = c; } }).transform("<p><!--x--></p>");
    const coerced: string[] = [];
    const probe = (tag: string) => ({ toString: () => (coerced.push(tag), "never") });
    el.tagName = probe("tagName");
    end.name = probe("name");
    comment.text = probe("text");
    return [coerced, el.tagName, end.name, comment.text, comment.removed, comment.before("x"), end.before("x"), end.remove()];
  }],
  ["detached: a missing argument is an undefined one", (R) => {
    const outcome = (fn: () => unknown) => { try { return { returned: fn() }; } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; } };
    const missing: Record<string, unknown> = {};
    const given: Record<string, unknown> = {};
    const compare = (name: string, object: any, methods: string[], ...first: unknown[]) => {
      for (const method of methods) {
        missing[`${name}.${method}(${first})`] = outcome(() => object[method](...first));
        given[`${name}.${method}(${first})`] = outcome(() => object[method](...first, undefined));
      }
    };
    new R().on("p", {
      element(el: any) {
        compare("element", el, ["before", "after", "replace", "prepend", "append", "setInnerContent", "getAttribute", "hasAttribute", "removeAttribute", "setAttribute", "onEndTag"]);
        compare("element", el, ["setAttribute"], "a");
        el.onEndTag((tag: any) => compare("endTag", tag, ["before", "after"]));
      },
      text: (chunk: any) => compare("text", chunk, ["before", "after", "replace"]),
      comments: (comment: any) => compare("comment", comment, ["before", "after", "replace"]),
    }).onDocument({ end: (end: any) => compare("end", end, ["append"]) }).transform("<p>t<!--c--></p>");
    return [JSON.stringify(missing) === JSON.stringify(given), missing];
  }],

  // Text, comments, doctype, document end
  ["text: chunks and lastInTextNode", (R) => {
    const seen: unknown[] = [];
    new R().on("p", { text(t: any) { seen.push([t.text, t.lastInTextNode, t.removed]); } }).transform("<p>Lorem ipsum!</p>");
    return seen;
  }],
  ["text: a text node split across chunks", async (R) => {
    const seen: unknown[] = [];
    await text(new R().on("p", { text(t: any) { seen.push([t.text, t.lastInTextNode]); } }).transform(new Response(pieces("<p>Lor", "em ip", "sum</p>"))));
    return seen;
  }],
  ["text: replace, before, after, remove", (R) => [
    new R().on("p", { text(t: any) { if (t.text) t.replace("<b>new</b>"); } }).transform("<p>old</p>"),
    new R().on("p", { text(t: any) { if (t.text) t.replace("<b>new</b>", { html: true }); } }).transform("<p>old</p>"),
    new R().on("p", { text(t: any) { if (t.text) { t.before("["); t.after("]"); } } }).transform("<p>old</p>"),
    new R().on("p", { text(t: any) { t.remove(); } }).transform("<p>old</p>"),
  ]],
  ["comments: mutations", (R) => {
    const input = "<p><!--test--></p>";
    const run = (f: (c: any) => void) => new R().on("p", { comments: f }).transform(input);
    return [
      run((c) => { c.before("<span>before</span>"); c.before("<span>before html</span>", { html: true }); c.after("<span>after</span>"); c.after("<span>after html</span>", { html: true }); }),
      run((c) => void c.replace("<span>replace</span>")),
      run((c) => void c.replace("<span>replace</span>", { html: true })),
      run((c) => { const seen = [c.removed]; c.remove(); seen.push(c.removed); }),
    ];
  }],
  ["comments: text property", (R) => {
    const seen: unknown[] = [];
    const out = new R().on("p", { comments(c: any) { seen.push(c.removed, c.text); c.text = "new"; seen.push(c.text); } }).transform("<p><!--test--></p>");
    return [out, seen];
  }],
  ["comments: text setter coerces with ToString, which may re-enter", (R) => new R().on("p", { comments(c: any) { c.text = { toString() { c.before("A"); return "B"; } }; } }).transform("<p><!--x--></p>")],
  ["comments: text with a closing sequence", (R) => new R().onDocument({ comments(c: any) { c.text = "a-->b"; } }).transform("<!--x-->")],
  ["document: comments and text", (R) => {
    const seen: unknown[] = [];
    new R().onDocument({ comments(c: any) { seen.push(["comment", c.text]); }, text(t: any) { seen.push(["text", t.text, t.lastInTextNode]); } }).transform("a<!--c--><b>d</b>");
    return seen;
  }],
  ["document: doctype fields", (R) => {
    const read = (html: string) => {
      let got: unknown;
      new R().onDocument({ doctype(d: any) { got = { name: d.name, publicId: d.publicId, systemId: d.systemId, removed: d.removed }; } }).transform(html);
      return got;
    };
    return [
      read("<!DOCTYPE html><div></div>"),
      read('<!DOCTYPE html PUBLIC "" ""><div></div>'),
      read('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><div></div>'),
    ];
  }],
  ["document: doctype remove", (R) => new R().onDocument({ doctype: (d: any) => void d.remove() }).transform("<!DOCTYPE html><p>x</p>")],
  ["document: end append", (R) => [new R().onDocument({ end: (e: any) => void e.append("<!--end-->", { html: true }) }).transform("<p>x</p>"), new R().onDocument({ end(e: any) { e.append("</p>"); e.append("<b>", { html: true }); } }).transform("<p>x")]],
  ["document: handlers in registration order", (R) => {
    const order: string[] = [];
    new R().onDocument({ text() { order.push("doc1"); } }).on("p", { text() { order.push("p"); } }).onDocument({ text() { order.push("doc2"); } }).transform("<p>x</p>");
    return order;
  }],

  // Selectors
  ["selectors", async (R) => {
    const cases: [string, string][] = [
      ["*", "<h1>1</h1><p>2</p>"],
      ["p:nth-child(2)", "<div><p>1</p><p>2</p><p>3</p></div>"],
      ["p:first-child", "<div><p>1</p><p>2</p><p>3</p></div>"],
      ["p:nth-of-type(2)", "<div><p>1</p><h1>2</h1><p>3</p><h1>4</h1><p>5</p></div>"],
      ["p:first-of-type", "<div><h1>1</h1><p>2</p><p>3</p></div>"],
      ["p:not(:first-child)", "<div><p>1</p><p>2</p><p>3</p></div>"],
      ["p.red", '<p class="red">1</p><p>2</p>'],
      ["h1#header", '<h1 id="header">1</h1><h1>2</h1>'],
      ["p[data-test]", "<p data-test>1</p><p>2</p>"],
      ['p[data-test="one"]', '<p data-test="one">1</p><p data-test="two">2</p>'],
      ['p[data-test="one" i]', '<p data-test="one">1</p><p data-test="OnE">2</p><p data-test="two">3</p>'],
      ['p[data-test="one" s]', '<p data-test="one">1</p><p data-test="OnE">2</p><p data-test="two">3</p>'],
      ['p[data-test~="two"]', '<p data-test="one two three">1</p><p data-test="one two">2</p><p data-test="one">3</p>'],
      ['p[data-test^="a"]', '<p data-test="a1">1</p><p data-test="a2">2</p><p data-test="b1">3</p>'],
      ['p[data-test$="1"]', '<p data-test="a1">1</p><p data-test="a2">2</p><p data-test="b1">3</p>'],
      ['p[data-test*="b"]', '<p data-test="abc">1</p><p data-test="ab">2</p><p data-test="a">3</p>'],
      ['p[data-test|="a"]', '<p data-test="a">1</p><p data-test="a-1">2</p><p data-test="a2">3</p>'],
      ["div span", "<div><h1><span>1</span></h1><span>2</span><b>3</b></div>"],
      ["div > span", "<div><h1><span>1</span></h1><span>2</span><b>3</b></div>"],
      ["a, b", "<a>1</a><b>2</b><i>3</i>"],
    ];
    const out: string[] = [];
    for (const [selector, input] of cases) out.push(await inner(selector, input)(R) as string);
    return out;
  }],
  ["selectors: many selectors with parentheses in a string", async (R) => {
    const selector = `b:not(p:nth-child(2)), ${Array(20).fill("p:nth-child(1)").join(", ")}, [a="${"(".repeat(100)}"]`;
    return text(new R().on(selector, { element: (e: any) => void e.remove() }).transform(new Response("<b></b><i></i>")));
  }],

  // Misc
  ["output: text() twice concurrently is one body", async (R) => {
    const res = new R().on("p", { element: (e: any) => void e.setInnerContent("y") }).transform(new Response("<p>x</p>")) as Response;
    const first = res.text();
    let second: unknown;
    try { await res.text(); second = "ok"; } catch (e: any) { second = e.constructor.name; }
    return [await first, second];
  }],
  ["output: a repeated transform in a loop", async (R) => {
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(await text(new R().on("div", { element: (e: any) => void e.setInnerContent("new") }).transform(new Response("<div>content</div>", { headers: new Headers({ "content-type": "text/html" }) }))) as string);
    return new Set(out).size === 1 ? out[0] : out;
  }],
  ["output: a large document", async (R) => {
    const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td id="${i}">${i}</td></tr>`).join("");
    let seen = 0;
    const out = await text(new R().on("td", { element(e: any) { seen++; e.setAttribute("n", e.getAttribute("id")); } }).transform(new Response(`<table>${rows}</table>`))) as string;
    return [seen, out.length, out.slice(0, 80), out.slice(-60)];
  }],
  ["output: toString tag", (R) => [String(new R()), Object.getOwnPropertyNames(R.prototype).sort()]],
  ["output: BOM is kept", (R) => JSON.stringify(new R().on("p", { element: (e: any) => void e.setAttribute("a", "1") }).transform("﻿<p>x</p>"))],
];

/** Every case's result (or error) as JSON values: what `expected.json` holds. */
export async function runCases(R: HTMLRewriterClass): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const [name, run] of cases) {
    try {
      const value = await run(R);
      results[name] = { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    } catch (e: any) {
      results[name] = { error: [e?.constructor?.name, e?.name, String(e?.message)] };
    }
  }
  return results;
}
