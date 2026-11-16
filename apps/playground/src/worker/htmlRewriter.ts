// `HTMLRewriter` (bun/src/runtime/api/html_rewriter.rs): Bun's lol-html in crates/htmlrewriter-wasm does the
// rewriting, this module is its JS side (handlers, the objects they get, the Response and string inputs).
// Self-contained (no imports): the worker and crates/htmlrewriter-wasm/test.ts both load it.
//
// How it differs from Bun: `transform(string | ArrayBuffer)` returns before any promise can settle, so a handler
// there that returns a Promise fails the rewrite (Bun waits one microtask checkpoint first and only then gives up).
// With a Response, handlers may await anything: the rewrite parks on the unit (lol-html's suspension) until it settles.

type Exports = {
  memory: WebAssembly.Memory;
  alloc(len: bigint): bigint;
  dealloc(ptr: bigint, len: bigint): void;
  ret_ptr(): bigint;
  err_ptr(): bigint;
  err_len(): bigint;
  selector_check(ptr: bigint, len: bigint): number;
  rw_new(): number;
  rw_on(rw: number, ptr: bigint, len: bigint, handler: number, flags: number): number;
  rw_on_document(rw: number, handler: number, flags: number): void;
  rw_open(rw: number): void;
  rw_write(rw: number, ptr: bigint, len: bigint): number;
  rw_end(rw: number): number;
  rw_resume(rw: number): number;
  rw_out_ptr(rw: number): bigint;
  rw_out_len(rw: number): bigint;
  rw_out_clear(rw: number): void;
  rw_free(rw: number): void;
  unit_content(id: number, op: number, ptr: bigint, len: bigint, html: number): number;
  unit_remove(id: number): number;
  unit_removed(id: number): number;
  el_remove_and_keep_content(id: number): number;
  el_tag_name(id: number): number;
  el_set_tag_name(id: number, ptr: bigint, len: bigint): number;
  el_namespace_uri(id: number): number;
  el_self_closing(id: number): number;
  el_can_have_content(id: number): number;
  el_get_attribute(id: number, ptr: bigint, len: bigint): number;
  el_has_attribute(id: number, ptr: bigint, len: bigint): number;
  el_set_attribute(id: number, np: bigint, nl: bigint, vp: bigint, vl: bigint): number;
  el_remove_attribute(id: number, ptr: bigint, len: bigint): number;
  el_attribute_at(id: number, index: number): number;
  el_on_end_tag(id: number, rw: number, handler: number): number;
  text_get(id: number): number;
  text_last_in_text_node(id: number): number;
  comment_get(id: number): number;
  comment_set(id: number, ptr: bigint, len: bigint): number;
  doctype_get(id: number, which: number): number;
  end_tag_name(id: number): number;
  end_tag_set_name(id: number, ptr: bigint, len: bigint): number;
};

// Mirrors crates/htmlrewriter-wasm/src/lib.rs.
const ELEMENT = 0, EL_COMMENT = 1, EL_TEXT = 2, DOCTYPE = 3, DOC_COMMENT = 4, DOC_TEXT = 5, DOC_END = 6, END_TAG = 7;
void ELEMENT, EL_COMMENT, EL_TEXT, DOCTYPE, DOC_COMMENT, DOC_TEXT, DOC_END;
/** Which of a registration's 4 handler ids a kind's callback has (element/doctype, comments, text, end). */
const SLOT = [0, 1, 2, 0, 1, 2, 3];
const STOP = 1, SUSPEND = 2;
const DETACHED = -1, NULL = -2, ERR = -3;
const DONE = 0, SUSPENDED = 1, FAILED = 2;
const BEFORE = 0, AFTER = 1, PREPEND = 2, APPEND = 3, REPLACE = 4, SET_INNER = 5;

type Fn = (this: unknown, unit: unknown) => unknown;
/** One `on()` (callbacks: element, comments, text) or `onDocument()` (doctype, comments, text, end). */
type Registration = { selector?: string; self: unknown; fns: (Fn | undefined)[] };
/** A callback registered with the wasm: the function and the `this` it is called on (the handler object). */
type Callback = { fn: Fn; self: unknown };

/** One `transform()`: the wasm rewriter, its callbacks and what stopped it. */
type Run = {
  id: number;
  /** By handler id: a registration takes 4 ids (one per callback, see `SLOT`), an `onEndTag` callback one. */
  callbacks: Map<number, Callback>;
  next: number;
  /** A handler's exception or rejection, or the error for a promise a string rewrite cannot wait for. */
  error?: { value: unknown };
  /** The promise of the handler the wasm is parked on. */
  pending?: Promise<unknown>;
  /** Set for `transform(string)` / `transform(ArrayBuffer)`: the noun for the error of a handler that returns a promise. */
  syncNoun?: string;
};

const enc = new TextEncoder();
/** For strings the host returns (`transform(string)`'s output): a leading BOM is dropped, as Bun's string conversion does. */
const dec = new TextDecoder();
/** For text inside the document: kept as it is. */
const raw = new TextDecoder("utf-8", { ignoreBOM: true });

const MAX_SELECTOR_NESTING = 32;

/** The deepest nesting of `(`; a `)` in an escape, a string or a comment closes nothing (`selector_nesting`). */
function selectorNesting(selector: string): number {
  const b = enc.encode(selector);
  let depth = 0;
  let deepest = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x5c) i++;
    else if (c === 0x22 || c === 0x27) {
      for (i++; i < b.length; i++) {
        if (b[i] === 0x5c) i++;
        else if (b[i] === c) break;
      }
    } else if (c === 0x2f && b[i + 1] === 0x2a) {
      for (i += 2; i < b.length; i++) if (b[i] === 0x2a && b[i + 1] === 0x2f) break;
      i++;
    } else if (c === 0x28) deepest = Math.max(deepest, ++depth);
    else if (c === 0x29) depth = Math.max(0, depth - 1);
  }
  return deepest;
}

const isObject = (v: unknown): v is Record<string, unknown> => (typeof v === "object" && v !== null) || typeof v === "function";

/** An error from lol-html itself (Bun names these `HTMLRewriterError`). */
const lolError = (message: string) => Object.assign(new Error(message), { name: "HTMLRewriterError" });

/** A content argument: strings as they are, anything else `ToString`'d (not null or undefined). */
function textArg(v: unknown): string {
  if (v === undefined || v === null) throw Object.assign(new TypeError("Expected string"), { code: "ERR_INVALID_ARG_TYPE" });
  return typeof v === "string" ? v : `${v as string}`;
}

const htmlOption = (options: unknown) => (isObject(options) && options.html ? 1 : 0);

/** `handler[name]`: absent, or a function. */
function callbackOf(handlers: Record<string, unknown>, name: string): Fn | undefined {
  const v = handlers[name];
  if (v === undefined) return undefined;
  if (typeof v !== "function") throw new TypeError(`${name} must be a function`);
  return v as Fn;
}

export function makeHTMLRewriter(loadModule: () => WebAssembly.Module): { new (): { on(selector: unknown, handlers: unknown): unknown; onDocument(handlers: unknown): unknown; transform(input: unknown): unknown } } {
  let wasm: Exports | undefined;
  const runs = new Map<number, Run>();

  /** The instance, loaded on first use. */
  function load(): Exports {
    if (wasm) return wasm;
    const env = {
      // The wasm reached a unit a handler wants (crates/htmlrewriter-wasm "hr_event"): run it.
      hr_event(rw: number, handler: number, kind: number, unit: number): number {
        const run = runs.get(rw);
        const callback = run?.callbacks.get(kind === END_TAG ? handler : handler + SLOT[kind]);
        if (!run || !callback) return STOP;
        let result: unknown;
        try {
          result = callback.fn.call(callback.self, wrap(kind, unit, run));
        } catch (value) {
          run.error = { value };
          return STOP;
        }
        if (result === undefined || result === null) return 0;
        if (result instanceof Error) {
          run.error = { value: result };
          return STOP;
        }
        if (!(result instanceof Promise)) return 0;
        if (run.syncNoun !== undefined) {
          result.catch(() => {});
          run.error = {
            value: new TypeError(
              `HTMLRewriter.transform() cannot synchronously return ${run.syncNoun} because a content handler returned a Promise. Pass a Response instead and await its body`,
            ),
          };
          return STOP;
        }
        run.pending = result;
        return SUSPEND;
      },
    };
    return (wasm = new WebAssembly.Instance(loadModule(), { env }).exports as unknown as Exports);
  }

  // ───────────── memory helpers ─────────────

  function put(w: Exports, b: Uint8Array): bigint {
    const ptr = w.alloc(BigInt(b.length));
    new Uint8Array(w.memory.buffer, Number(ptr), b.length).set(b);
    return ptr;
  }

  /** `f` with `s` (UTF-8) in wasm memory. */
  function withStr<T>(s: string, f: (ptr: bigint, len: bigint) => T): T {
    const w = load();
    const b = enc.encode(s);
    const ptr = put(w, b);
    try {
      return f(ptr, BigInt(b.length));
    } finally {
      w.dealloc(ptr, BigInt(b.length));
    }
  }

  const readRet = (w: Exports, len: number) => raw.decode(new Uint8Array(w.memory.buffer, Number(w.ret_ptr()), len));
  const lastError = (w: Exports) => lolError(raw.decode(new Uint8Array(w.memory.buffer, Number(w.err_ptr()), Number(w.err_len()))));

  /** A unit export's result: its string, `null` for none, `undefined` once the unit is gone; `ERR` throws. */
  function str(code: number): string | null | undefined {
    const w = load();
    if (code >= 0) return readRet(w, code);
    if (code === NULL) return null;
    if (code === ERR) throw lastError(w);
    return undefined;
  }

  /** An export that can fail: throws lol-html's error. Returns whether the unit was still there. */
  function done(code: number): boolean {
    if (code === ERR) throw lastError(load());
    return code !== DETACHED;
  }

  /** Setters do nothing, not even coerce their value, once the unit is gone. */
  const gone = (id: number) => load().unit_removed(id) === DETACHED;

  const flag = (code: number): boolean | undefined => (code === DETACHED ? undefined : code === 1);

  // ───────────── the objects handlers get ─────────────

  /** `none` is what a chainable method answers after its handler returned: `undefined` or `null`, per class (as Bun). */
  function content<T extends object>(unit: number, op: number, none: undefined | null, self: T, c: unknown, options: unknown): T | undefined | null {
    const text = textArg(c);
    const html = htmlOption(options);
    return withStr(text, (p, l) => (load().unit_content(unit, op, p, l, html) === DETACHED ? none : self));
  }

  const endIteration = Symbol("end");

  class AttributeIterator {
    #element: ElementUnit | undefined;
    #index = 0;
    constructor(element: ElementUnit) {
      this.#element = element;
    }
    next(): IteratorResult<[string, string]> {
      const w = load();
      const code = this.#element ? w.el_attribute_at(this.#element.id, this.#index) : NULL;
      if (code < 0) {
        this.#element = undefined;
        return { value: undefined, done: true };
      }
      this.#index++;
      const [name, value] = readRet(w, code).split("\0");
      return { value: [name, value], done: false };
    }
    [Symbol.iterator]() {
      return this;
    }
    [endIteration]() {
      this.#element = undefined;
    }
  }

  class ElementUnit {
    #iterators: AttributeIterator[] = [];
    id: number;
    run: Run;
    constructor(id: number, run: Run) {
      this.id = id;
      this.run = run;
    }
    /** Setting or removing an attribute renumbers them: live iterators end rather than repeat or skip one. */
    #endIterators() {
      for (const it of this.#iterators.splice(0)) it[endIteration]();
    }
    get tagName() {
      return str(load().el_tag_name(this.id));
    }
    set tagName(v: unknown) {
      if (gone(this.id)) return;
      const name = textArg(v);
      withStr(name, (p, l) => done(load().el_set_tag_name(this.id, p, l)));
    }
    get removed() {
      return flag(load().unit_removed(this.id));
    }
    get selfClosing() {
      return flag(load().el_self_closing(this.id));
    }
    get canHaveContent() {
      return flag(load().el_can_have_content(this.id));
    }
    get namespaceURI() {
      return str(load().el_namespace_uri(this.id));
    }
    get attributes() {
      if (load().el_attribute_at(this.id, 0) === DETACHED) return undefined;
      const it = new AttributeIterator(this);
      this.#iterators.push(it);
      return it;
    }
    getAttribute(name: unknown) {
      const n = textArg(name);
      const r = withStr(n, (p, l) => load().el_get_attribute(this.id, p, l));
      return r === DETACHED ? null : str(r);
    }
    hasAttribute(name: unknown) {
      const n = textArg(name);
      return withStr(n, (p, l) => load().el_has_attribute(this.id, p, l)) === 1;
    }
    setAttribute(name: unknown, value: unknown) {
      const n = textArg(name);
      const v = textArg(value);
      this.#endIterators();
      return withStr(n, (np, nl) => withStr(v, (vp, vl) => (done(load().el_set_attribute(this.id, np, nl, vp, vl)) ? this : undefined)));
    }
    removeAttribute(name: unknown) {
      const n = textArg(name);
      this.#endIterators();
      return withStr(n, (p, l) => (done(load().el_remove_attribute(this.id, p, l)) ? this : undefined));
    }
    before(c: unknown, o?: unknown) {
      return content(this.id, BEFORE, undefined, this, c, o);
    }
    after(c: unknown, o?: unknown) {
      return content(this.id, AFTER, undefined, this, c, o);
    }
    prepend(c: unknown, o?: unknown) {
      return content(this.id, PREPEND, undefined, this, c, o);
    }
    append(c: unknown, o?: unknown) {
      return content(this.id, APPEND, undefined, this, c, o);
    }
    replace(c: unknown, o?: unknown) {
      return content(this.id, REPLACE, undefined, this, c, o);
    }
    setInnerContent(c: unknown, o?: unknown) {
      return content(this.id, SET_INNER, undefined, this, c, o);
    }
    remove() {
      return load().unit_remove(this.id) === DETACHED ? undefined : this;
    }
    removeAndKeepContent() {
      return load().el_remove_and_keep_content(this.id) === DETACHED ? undefined : this;
    }
    onEndTag(handler: unknown) {
      const w = load();
      if (w.el_attribute_at(this.id, 0) === DETACHED) return null;
      if (typeof handler !== "function") throw new TypeError("Expected a function");
      const run = this.run;
      const callback: Callback = { fn: handler as Fn, self: undefined };
      const handlerId = run.next++;
      const r = w.el_on_end_tag(this.id, run.id, handlerId);
      if (r === ERR) throw lastError(w);
      // r > 0: the element has an end tag callback already, which this one replaces (as in Bun).
      run.callbacks.set(r > 0 ? r : handlerId, callback);
      return this;
    }
  }

  class TextUnit {
    id: number;
    constructor(id: number) {
      this.id = id;
    }
    get text() {
      return str(load().text_get(this.id));
    }
    get lastInTextNode() {
      return flag(load().text_last_in_text_node(this.id));
    }
    get removed() {
      return flag(load().unit_removed(this.id));
    }
    before(c: unknown, o?: unknown) {
      return content(this.id, BEFORE, undefined, this, c, o);
    }
    after(c: unknown, o?: unknown) {
      return content(this.id, AFTER, undefined, this, c, o);
    }
    replace(c: unknown, o?: unknown) {
      return content(this.id, REPLACE, undefined, this, c, o);
    }
    remove() {
      return load().unit_remove(this.id) === DETACHED ? undefined : this;
    }
  }

  class CommentUnit {
    id: number;
    constructor(id: number) {
      this.id = id;
    }
    get text() {
      return str(load().comment_get(this.id)) ?? null;
    }
    set text(v: unknown) {
      if (gone(this.id)) return;
      const t = textArg(v);
      withStr(t, (p, l) => done(load().comment_set(this.id, p, l)));
    }
    get removed() {
      return flag(load().unit_removed(this.id));
    }
    before(c: unknown, o?: unknown) {
      return content(this.id, BEFORE, null, this, c, o);
    }
    after(c: unknown, o?: unknown) {
      return content(this.id, AFTER, null, this, c, o);
    }
    replace(c: unknown, o?: unknown) {
      return content(this.id, REPLACE, null, this, c, o);
    }
    remove() {
      return load().unit_remove(this.id) === DETACHED ? null : this;
    }
  }

  class DocTypeUnit {
    id: number;
    constructor(id: number) {
      this.id = id;
    }
    get name() {
      return str(load().doctype_get(this.id, 0));
    }
    get publicId() {
      return str(load().doctype_get(this.id, 1));
    }
    get systemId() {
      return str(load().doctype_get(this.id, 2));
    }
    get removed() {
      return flag(load().unit_removed(this.id));
    }
    remove() {
      return load().unit_remove(this.id) === DETACHED ? undefined : this;
    }
  }

  class DocEndUnit {
    id: number;
    constructor(id: number) {
      this.id = id;
    }
    append(c: unknown, o?: unknown) {
      return content(this.id, APPEND, null, this, c, o);
    }
  }

  class EndTagUnit {
    id: number;
    constructor(id: number) {
      this.id = id;
    }
    get name() {
      return str(load().end_tag_name(this.id));
    }
    set name(v: unknown) {
      if (gone(this.id)) return;
      const n = textArg(v);
      withStr(n, (p, l) => load().end_tag_set_name(this.id, p, l));
    }
    before(c: unknown, o?: unknown) {
      return content(this.id, BEFORE, null, this, c, o);
    }
    after(c: unknown, o?: unknown) {
      return content(this.id, AFTER, null, this, c, o);
    }
    remove() {
      return load().unit_remove(this.id) === DETACHED ? undefined : this;
    }
  }

  function wrap(kind: number, id: number, run: Run): unknown {
    switch (kind) {
      case ELEMENT:
        return new ElementUnit(id, run);
      case EL_COMMENT:
      case DOC_COMMENT:
        return new CommentUnit(id);
      case EL_TEXT:
      case DOC_TEXT:
        return new TextUnit(id);
      case DOCTYPE:
        return new DocTypeUnit(id);
      case DOC_END:
        return new DocEndUnit(id);
      default:
        return new EndTagUnit(id);
    }
  }

  // ───────────── running a rewrite ─────────────

  /** What the wasm has written since the last call. */
  function take(w: Exports, rw: number): Uint8Array | undefined {
    const len = Number(w.rw_out_len(rw));
    if (len === 0) return undefined;
    const out = new Uint8Array(w.memory.buffer, Number(w.rw_out_ptr(rw)), len).slice();
    w.rw_out_clear(rw);
    return out;
  }

  /** What stopped the rewrite: a handler's own exception, else lol-html's error. */
  const failure = (run: Run) => (run.error ? run.error.value : lastError(load()));

  /** Waits for the handler the wasm is parked on and resumes it, until no handler is parked. */
  async function settle(run: Run, status: number): Promise<number> {
    while (status === SUSPENDED) {
      const pending = run.pending;
      run.pending = undefined;
      try {
        await pending;
      } catch (value) {
        run.error = { value };
        return FAILED;
      }
      status = load().rw_resume(run.id);
    }
    return status;
  }

  /** Writes `bytes` (or ends the input when `undefined`); the status once no handler is parked. */
  function feed(run: Run, bytes: Uint8Array | undefined): Promise<number> | number {
    const w = load();
    let status: number;
    if (!bytes) status = w.rw_end(run.id);
    else {
      const ptr = put(w, bytes);
      try {
        status = w.rw_write(run.id, ptr, BigInt(bytes.length));
      } finally {
        w.dealloc(ptr, BigInt(bytes.length));
      }
    }
    return status === SUSPENDED ? settle(run, status) : status;
  }

  function close(run: Run) {
    if (!runs.delete(run.id)) return;
    load().rw_free(run.id);
  }

  class HTMLRewriter {
    #elements: Registration[] = [];
    #documents: Registration[] = [];

    on(selector: unknown, handlers: unknown): this {
      if (arguments.length < 2) throw new TypeError("Missing argument");
      if (selector === undefined || selector === null) throw new TypeError("Expected string");
      const source = `${selector as string}`;
      if (selectorNesting(source) > MAX_SELECTOR_NESTING) throw lolError("Selector is nested too deeply.");
      if (withStr(source, (p, l) => load().selector_check(p, l)) === ERR) throw lastError(load());
      if (!isObject(handlers)) throw new TypeError("Expected object");
      const fns = ["element", "comments", "text"].map((name) => callbackOf(handlers, name));
      this.#elements.push({ selector: source, self: handlers, fns });
      return this;
    }

    onDocument(handlers: unknown): this {
      if (arguments.length < 1) throw new TypeError("Missing argument");
      if (!isObject(handlers)) throw new TypeError("Expected object");
      const fns = ["doctype", "comments", "text", "end"].map((name) => callbackOf(handlers, name));
      this.#documents.push({ self: handlers, fns });
      return this;
    }

    transform(input: unknown): unknown {
      if (arguments.length < 1) throw new TypeError("Missing argument");
      if (input instanceof Response) return this.#response(input);
      if (typeof input === "string") return dec.decode(this.#sync(enc.encode(input), "a string"));
      if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
        return this.#sync(new Uint8Array(input), "an ArrayBuffer");
      }
      if (ArrayBuffer.isView(input)) {
        return this.#sync(new Uint8Array(input.buffer, input.byteOffset, input.byteLength), "an ArrayBuffer");
      }
      throw new TypeError("Expected Response or Body");
    }

    /** A wasm rewriter with this one's handlers, ready to be written to. `syncNoun`: see `Run`. */
    #open(syncNoun?: string): Run {
      const w = load();
      const run: Run = { id: w.rw_new(), callbacks: new Map(), next: 1, syncNoun };
      runs.set(run.id, run);
      const flagsOf = (r: Registration) => r.fns.reduce((flags, fn, bit) => flags | (fn ? 1 << bit : 0), 0);
      const reserve = (r: Registration) => {
        const handler = run.next;
        run.next += 4;
        r.fns.forEach((fn, bit) => fn && run.callbacks.set(handler + bit, { fn, self: r.self }));
        return handler;
      };
      for (const r of this.#elements) {
        const handler = reserve(r);
        withStr(r.selector!, (p, l) => w.rw_on(run.id, p, l, handler, flagsOf(r)));
      }
      for (const r of this.#documents) w.rw_on_document(run.id, reserve(r), flagsOf(r));
      w.rw_open(run.id);
      return run;
    }

    /** `transform(string | ArrayBuffer)`: all of it before returning, so no handler can wait. Returns a new ArrayBuffer's bytes. */
    #sync(bytes: Uint8Array, noun: string): ArrayBuffer {
      const run = this.#open(noun);
      try {
        for (const chunk of [bytes, undefined]) {
          // A handler's promise is turned into an error by `hr_event`, so the status is never SUSPENDED here.
          if (feed(run, chunk) !== DONE) throw failure(run);
        }
        const out = take(load(), run.id);
        return out ? (out.buffer as ArrayBuffer) : new ArrayBuffer(0);
      } finally {
        close(run);
      }
    }

    /** `transform(Response)`: a Response whose body is the rewritten input, read (and rewritten) as it is consumed. */
    #response(res: Response): Response {
      if (res.bodyUsed || res.body?.locked) throw new TypeError("Response body already used");
      const run = this.#open();
      const reader = res.body?.getReader();
      // Bun takes the input as it starts: reading now marks it used the same way.
      let next = reader?.read();
      let failed: { value: unknown } | undefined;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            for (;;) {
              const r = next ? await next : { done: true as const, value: undefined };
              if (!r.done) next = reader!.read();
              if ((await feed(run, r.value)) !== DONE) throw failure(run);
              const out = take(load(), run.id);
              if (out) controller.enqueue(out);
              if (r.done) {
                close(run);
                controller.close();
                return;
              }
              if (out) return;
            }
          } catch (e) {
            failed = { value: e };
            close(run);
            reader?.cancel(e).catch(() => {});
            controller.error(e);
          }
        },
        cancel(reason) {
          close(run);
          return reader?.cancel(reason);
        },
      });
      const status = res.status >= 200 && res.status <= 599 ? res.status : 200;
      const nullBody = status === 204 || status === 205 || status === 304;
      const out = new Response(nullBody ? null : stream, { status, statusText: res.statusText, headers: res.headers });
      // Chrome turns the error of a stream behind a Response into a TypeError ("Failed to fetch") when the body is read
      // whole; Bun rejects with the handler's own error, so these give it back (`body` readers already get it).
      for (const method of ["text", "json", "arrayBuffer", "bytes", "blob", "formData"] as const) {
        const read = (out as unknown as Record<string, (() => Promise<unknown>) | undefined>)[method];
        if (typeof read !== "function") continue;
        Object.defineProperty(out, method, {
          configurable: true,
          writable: true,
          value: function (this: Response) {
            return read.call(this).catch((e: unknown) => {
              throw failed ? failed.value : e;
            });
          },
        });
      }
      return out;
    }
  }

  Object.defineProperty(HTMLRewriter.prototype, Symbol.toStringTag, { value: "HTMLRewriter", configurable: true });
  return HTMLRewriter;
}
