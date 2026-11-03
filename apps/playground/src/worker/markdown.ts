// `Bun.markdown` (bun/src/runtime/api/MarkdownObject.rs, MarkdownObject.bind.ts): `html` and `ansi` are Bun's renderers
// in transpile-wasm; `render` and `react` replay the parser's events (transpile-wasm's `markdown_events_c`) the way
// Bun's JS callback renderer and React renderer handle them. No imports: the data-API tests import this file outside
// the playground, with the wasm functions passed in.

/** transpile-wasm's markdown functions: their text, or `{ error }` with a parser error's name. */
export type MarkdownWasm = {
  html(input: Uint8Array, options: number): string | { error: string };
  ansi(input: Uint8Array, theme: number, columns: number): string | { error: string };
  events(input: Uint8Array, options: number): string | { error: string };
};

const codeError = (C: ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor, code: string, message: string) => Object.assign(new C(message), { code });
const expected = () => codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Expected a string or buffer to render");

/** The input's UTF-8: a string, an ArrayBuffer or a view of one. */
function bytesOf(input: unknown): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw expected();
}

const MAX_INPUT_LEN = 0xffffffff;
/** Bun's `parser_err_to_js`. */
function parserError(name: string, inputLength: number): Error {
  switch (name) {
    case "InputTooLarge":
      return codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "input.byteLength" is out of range. It must be <= ${MAX_INPUT_LEN}. Received ${inputLength}`);
    case "TooManyBlocks":
      return codeError(RangeError, "ERR_OUT_OF_RANGE", "markdown input requires more block metadata than the parser can address (4 GiB)");
    case "StackOverflow":
      return new RangeError("Maximum call stack size exceeded.");
    default:
      return new RangeError("Out of memory");
  }
}

function result(r: string | { error: string }, input: Uint8Array): string {
  if (typeof r === "string") return r;
  throw parserError(r.error, input.length);
}

const isObject = (v: unknown): v is Record<string, unknown> => (typeof v === "object" && v !== null) || typeof v === "function";

// The option bits of transpile-wasm's `md_options` (apis.rs).
const BITS = {
  tables: 1,
  strikethrough: 1 << 1,
  tasklists: 1 << 2,
  autolinkUrl: 1 << 3,
  autolinkWww: 1 << 4,
  autolinkEmail: 1 << 5,
  hardSoftBreaks: 1 << 6,
  wikiLinks: 1 << 7,
  underline: 1 << 8,
  latexMath: 1 << 9,
  collapseWhitespace: 1 << 10,
  permissiveAtxHeaders: 1 << 11,
  noIndentedCodeBlocks: 1 << 12,
  noHtmlBlocks: 1 << 13,
  noHtmlSpans: 1 << 14,
  tagFilter: 1 << 15,
  headingIds: 1 << 16,
  autolinkHeadings: 1 << 17,
};
/** The boolean options and their snake_case alternative names (`MarkdownObject.bind.ts`). */
const FLAGS: [keyof typeof BITS, string | null][] = [
  ["tables", null],
  ["strikethrough", null],
  ["tasklists", null],
  ["hardSoftBreaks", "hard_soft_breaks"],
  ["wikiLinks", "wiki_links"],
  ["underline", null],
  ["latexMath", "latex_math"],
  ["collapseWhitespace", "collapse_whitespace"],
  ["permissiveAtxHeaders", "permissive_atx_headers"],
  ["noIndentedCodeBlocks", "no_indented_code_blocks"],
  ["noHtmlBlocks", "no_html_blocks"],
  ["noHtmlSpans", "no_html_spans"],
  ["tagFilter", "tag_filter"],
];

/**
 * The `md::Options` bits of `Bun.markdown`'s options (`parser_options!`): a non-object is no options; a flag is read
 * loosely (truthy); `autolinks` and `headings` are a boolean for all of theirs or an object of each.
 */
function optionBits(options: unknown): number {
  let bits = BITS.tables | BITS.strikethrough | BITS.tasklists;
  if (!isObject(options)) return bits;
  const set = (bit: number, on: unknown) => {
    if (on === undefined) return;
    bits = on ? bits | bit : bits & ~bit;
  };
  const each = (v: unknown, members: [string, number][]) => {
    if (typeof v === "boolean") {
      if (v) for (const [, bit] of members) bits |= bit;
    } else if (isObject(v)) for (const [name, bit] of members) set(bit, v[name]);
  };
  each(options.autolinks, [
    ["url", BITS.autolinkUrl],
    ["www", BITS.autolinkWww],
    ["email", BITS.autolinkEmail],
  ]);
  each(options.headings, [
    ["ids", BITS.headingIds],
    ["autolink", BITS.autolinkHeadings],
  ]);
  for (const [name, alt] of FLAGS) {
    let v = options[name];
    if (v === undefined && alt) v = options[alt];
    set(BITS[name], v);
  }
  return bits;
}

// transpile-wasm's event numbers (`bun_md::types`).
const Block = { Doc: 0, Quote: 1, Ul: 2, Ol: 3, Li: 4, Hr: 5, H: 6, Code: 7, Html: 8, P: 9, Table: 10, Thead: 11, Tbody: 12, Tr: 13, Th: 14, Td: 15 } as const;
const Span = { Em: 0, Strong: 1, A: 2, Img: 3, Code: 4, Del: 5, Latexmath: 6, LatexmathDisplay: 7, Wikilink: 8, U: 9 } as const;
const Text = { Normal: 0, NullChar: 1, Br: 2, Softbr: 3, Entity: 4 } as const;

type Event = ["b", number, unknown] | ["B", number, string | null] | ["s", number, string, string] | ["S", number] | ["t", number, string];

/** What a renderer does with the events. */
type Handler = {
  enterBlock(type: number, extra: unknown): void;
  leaveBlock(type: number, slug: string | null): void;
  enterSpan(type: number, href: string, title: string): void;
  leaveSpan(type: number): void;
  text(type: number, content: string): void;
};

function replay(events: Event[], h: Handler) {
  for (const e of events) {
    if (e[0] === "b") h.enterBlock(e[1], e[2]);
    else if (e[0] === "B") h.leaveBlock(e[1], e[2]);
    else if (e[0] === "s") h.enterSpan(e[1], e[2], e[3]);
    else if (e[0] === "S") h.leaveSpan(e[1]);
    else h.text(e[1], e[2]);
  }
}

const BLOCK_TAGS = ["div", "blockquote", "ul", "ol", "li", "hr", "h", "pre", "html", "p", "table", "thead", "tbody", "tr", "th", "td"];
const SPAN_TAGS = ["em", "strong", "a", "img", "code", "del", "math", "math", "a", "u"];
const blockTag = (type: number, level: unknown) => (type === Block.H ? `h${Math.min(Math.max(Number(level), 1), 6)}` : BLOCK_TAGS[type]);

/** `Bun.markdown.render`'s callbacks, by block type and span type. */
const BLOCK_CALLBACKS = ["", "blockquote", "list", "list", "listItem", "hr", "heading", "code", "html", "paragraph", "table", "thead", "tbody", "tr", "th", "td"];
const SPAN_CALLBACKS = ["emphasis", "strong", "link", "image", "codespan", "strikethrough", "", "", "", ""];

/** A callback's result as text (JSC's message for a symbol). */
function toText(v: unknown): string {
  if (typeof v === "symbol") throw new TypeError("Cannot convert a symbol to a string");
  return `${v as string}`;
}

type Entry = { buffer: string; type: number; data: unknown; childIndex: number; href: string; title: string };

/** Bun's `JsCallbackRenderer`: only an element with a callback buffers its children; the rest write to the enclosing buffer. */
function renderWithCallbacks(events: Event[], callbacks: Record<string, ((...a: unknown[]) => unknown) | null>): string {
  const entry = (type: number, data: unknown = 0, href = "", title = ""): Entry => ({ buffer: "", type, data, childIndex: 0, href, title });
  const stack: Entry[] = [];
  const collecting: number[] = [];
  let listDepth = 0;
  const push = (e: Entry, collects: boolean) => {
    if (collects) collecting.push(stack.length);
    if (e.type === Block.Ul || e.type === Block.Ol) listDepth++;
    stack.push(e);
  };
  const pop = (): Entry | undefined => {
    if (stack.length <= 1) return undefined;
    const e = stack.pop()!;
    if (collecting[collecting.length - 1] === stack.length) collecting.pop();
    if (e.type === Block.Ul || e.type === Block.Ol) listDepth--;
    return e;
  };
  const append = (s: string) => {
    if (collecting.length) stack[collecting[collecting.length - 1]].buffer += s;
  };
  const popAndCall = (callback: ((...a: unknown[]) => unknown) | null, meta?: object) => {
    const e = pop();
    if (!e) return;
    if (!callback) return append(e.buffer);
    const r = meta ? callback(e.buffer, meta) : callback(e.buffer);
    if (r !== undefined && r !== null) append(toText(r));
  };
  const textOut = (s: string) => {
    if (callbacks.text) {
      const r = callbacks.text(s);
      if (r !== undefined && r !== null) append(toText(r));
    } else append(s);
  };
  // As `Default` for the stack's root, a Doc: it always collects.
  push(entry(Block.Doc), true);
  const blockCallback = (type: number) => callbacks[BLOCK_CALLBACKS[type]] ?? null;
  const spanCallback = (type: number) => callbacks[SPAN_CALLBACKS[type]] ?? null;
  replay(events, {
    enterBlock(type, extra) {
      if (type === Block.Doc) return;
      let childIndex = 0;
      if (type === Block.Li && stack.length) childIndex = stack[stack.length - 1].childIndex++;
      const e = entry(type, extra);
      e.childIndex = childIndex;
      push(e, !!blockCallback(type));
    },
    leaveBlock(type, slug) {
      if (type === Block.Doc) return;
      const callback = blockCallback(type);
      let meta: object | undefined;
      if (callback) {
        const top = stack[stack.length - 1];
        const depth = Math.max(listDepth - 1, 0);
        switch (type) {
          case Block.H:
            meta = slug === null ? { level: top.data } : { level: top.data, id: slug };
            break;
          case Block.Ol:
            meta = { ordered: true, start: top.data, depth };
            break;
          case Block.Ul:
            meta = { ordered: false, start: undefined, depth };
            break;
          case Block.Code:
            if (top.data) meta = { language: top.data };
            break;
          case Block.Th:
          case Block.Td:
            meta = { align: top.data ?? undefined };
            break;
          case Block.Li: {
            const parent = stack.length >= 2 ? stack[stack.length - 2] : undefined;
            const ordered = parent?.type === Block.Ol;
            meta = { index: top.childIndex, depth, ordered, start: ordered ? parent!.data : undefined, checked: top.data ?? undefined };
            break;
          }
        }
      }
      popAndCall(callback, meta);
    },
    enterSpan(type, href, title) {
      const collects = !!spanCallback(type);
      push(collects ? entry(Block.Doc, 0, href, title) : entry(Block.Doc), collects);
    },
    leaveSpan(type) {
      const callback = spanCallback(type);
      const top = stack[stack.length - 1];
      let meta: object | undefined;
      if (callback && top) {
        if (type === Span.A) meta = { href: top.href, title: top.title || undefined };
        else if (type === Span.Img) meta = top.title ? { src: top.href, title: top.title } : { src: top.href };
      }
      popAndCall(callback, meta);
    },
    text(type, content) {
      if (type === Text.NullChar) append("�");
      else if (type === Text.Br || type === Text.Softbr) append("\n");
      else textOut(content);
    },
  });
  return stack[0].buffer;
}

const REACT_ELEMENT = Symbol.for("react.element");
const REACT_TRANSITIONAL_ELEMENT = Symbol.for("react.transitional.element");
const REACT_FRAGMENT = Symbol.for("react.fragment");

/** Bun's `ParseRenderer` in React mode: elements of tag names (or the components given for them), text as strings. */
function renderReact(events: Event[], components: Record<string, unknown>, $$typeof: symbol): unknown[] {
  type Node = { children: unknown[]; data: unknown; href: string; title: string };
  const stack: Node[] = [{ children: [], data: 0, href: "", title: "" }];
  const element = (type: unknown, props: object) => ({ $$typeof, type, key: null, ref: null, props });
  const component = (tag: string) => components[tag] ?? tag;
  replay(events, {
    enterBlock(type, extra) {
      if (type === Block.Doc) return;
      stack.push({ children: [], data: extra, href: "", title: "" });
    },
    leaveBlock(type, slug) {
      if (type === Block.Doc || stack.length <= 1) return;
      const e = stack.pop()!;
      const props: Record<string, unknown> = {};
      if (type === Block.H && slug !== null) props.id = slug;
      else if (type === Block.Ol) props.start = e.data;
      else if (type === Block.Li && e.data !== null) props.checked = e.data;
      else if (type === Block.Code && e.data) props.language = e.data;
      else if ((type === Block.Th || type === Block.Td) && e.data !== null) props.align = e.data;
      if (type !== Block.Hr) props.children = e.children;
      stack[stack.length - 1].children.push(element(component(blockTag(type, e.data)), props));
    },
    enterSpan(_type, href, title) {
      stack.push({ children: [], data: 0, href, title });
    },
    leaveSpan(type) {
      if (stack.length <= 1) return;
      const e = stack.pop()!;
      const props: Record<string, unknown> = {};
      if (type === Span.A) {
        props.href = e.href;
        if (e.title) props.title = e.title;
      } else if (type === Span.Img) {
        props.src = e.href;
        if (e.title) props.title = e.title;
      } else if (type === Span.Wikilink) props.target = e.href;
      else if (type === Span.LatexmathDisplay) props.display = true;
      if (type === Span.Img) {
        // A void element: its text is the `alt`.
        if (e.children.length === 1) {
          if (typeof e.children[0] === "string") props.alt = e.children[0];
        } else if (e.children.length > 1) {
          const alt = e.children.filter((c) => typeof c === "string").join("");
          if (alt) props.alt = alt;
        }
      } else props.children = e.children;
      stack[stack.length - 1].children.push(element(component(SPAN_TAGS[type]), props));
    },
    text(type, content) {
      const children = stack[stack.length - 1].children;
      if (type === Text.Br) children.push(element(component("br"), {}));
      else if (type === Text.Softbr) children.push("\n");
      else if (type === Text.NullChar) children.push("�");
      else children.push(content);
    },
  });
  return stack[0].children;
}

const CALLBACK_NAMES = [
  "heading",
  "paragraph",
  "blockquote",
  "code",
  "list",
  "listItem",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "html",
  "strong",
  "emphasis",
  "link",
  "image",
  "codespan",
  "strikethrough",
  "text",
];
const COMPONENT_NAMES = "h1 h2 h3 h4 h5 h6 p blockquote ul ol li pre hr html table thead tbody tr th td em strong a img code del math u br".split(" ");

/** `Bun.markdown`, over transpile-wasm's functions (`wasm` is called on first use). `light` is `ansi`'s default background. */
export function makeMarkdown(wasm: () => MarkdownWasm, light: () => boolean = () => false): object {
  const events = (input: unknown, options: unknown): Event[] => {
    if (input === undefined || input === null) throw expected();
    const bytes = bytesOf(input);
    return JSON.parse(result(wasm().events(bytes, optionBits(options)), bytes)) as Event[];
  };
  const markdown = {
    html(input: unknown, options?: unknown): string {
      const bytes = bytesOf(input);
      return result(wasm().html(bytes, optionBits(options)), bytes);
    },
    ansi(input: unknown, theme?: unknown): string {
      const bytes = bytesOf(input);
      const t = isObject(theme) ? theme : {};
      const flag = (v: unknown, otherwise: boolean) => (v === undefined ? otherwise : !!v);
      const bits = (flag(t.colors, true) ? 1 : 0) | (flag(t.hyperlinks, false) ? 2 : 0) | (flag(t.kittyGraphics, false) ? 4 : 0) | (flag(t.light, t.light === undefined && light()) ? 8 : 0);
      // `columns as u16`: saturating, NaN is 0; not a number is the default, 80.
      const c = t.columns;
      const columns = typeof c === "number" ? (Number.isNaN(c) ? 0 : Math.min(Math.max(Math.trunc(c), 0), 0xffff)) : 80;
      return result(wasm().ansi(bytes, bits, columns), bytes);
    },
    render(input: unknown, callbacks?: unknown, options?: unknown): string {
      const cbs: Record<string, ((...a: unknown[]) => unknown) | null> = {};
      if (isObject(callbacks)) {
        for (const name of CALLBACK_NAMES) {
          const v = callbacks[name];
          cbs[name] = typeof v === "function" ? (v as (...a: unknown[]) => unknown) : null;
        }
      }
      return renderWithCallbacks(events(input, options), cbs);
    },
    react(input: unknown, components?: unknown, options?: unknown): unknown {
      // React 18 and older: `react.element`; else `react.transitional.element`.
      const v = isObject(options) ? options.reactVersion : undefined;
      const $$typeof = typeof v === "number" && (Number.isNaN(v) ? 0 : Math.trunc(v)) <= 18 ? REACT_ELEMENT : REACT_TRANSITIONAL_ELEMENT;
      const comps: Record<string, unknown> = {};
      if (isObject(components)) {
        for (const name of COMPONENT_NAMES) {
          const c = components[name];
          if (c !== undefined && c !== null && c !== "" && typeof c !== "boolean") comps[name] = c;
        }
      }
      const children = renderReact(events(input, options), comps, $$typeof);
      return { $$typeof, type: REACT_FRAGMENT, key: null, ref: null, props: { children } };
    },
  };
  // Bun's lengths.
  for (const [name, length] of [["html", 1], ["ansi", 2], ["render", 3], ["react", 3]] as const) Object.defineProperty(markdown[name], "length", { value: length });
  return markdown;
}
