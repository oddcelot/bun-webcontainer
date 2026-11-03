// <bun-playground>: builds an iframe to <src>embed and talks to it over postMessage (protocol: ./protocol.ts).
// Dependency-free: runbun.dev serves it standalone as embed.js (apps/playground/embed-element/), npm ships it as
// @runbun/embed. Registering the elements is `define` (index.ts calls it), so a page can pick the playground first.
// Types only: a runtime import would make runbun.dev's build share protocol.ts with the embed page as a chunk, and
// embed.js, loaded from other origins, has to be one file.
import type { Event, Feature, Mode, Reply, Request, Vars } from "./protocol.js";

const TAG = "bunPlayground"; // = protocol TAG
const VERSION = 1; // = protocol VERSION

/** Where embeds without a `src` frame the playground from; `define` sets it. */
let defaultSrc = "https://runbun.dev/";

const PARAMS = [
  "mode",
  "features",
  "file",
  "path",
  "autorun",
  "theme",
  "family",
  "fonts",
  "readonly",
  "persist",
  "example",
  "repo",
  "expand",
  "status",
];
/** Keys a page-wide `<bun-playground-defaults>` may set. Not `file path example repo share title persist`: those are per
 * embed (a shared `persist` key would make embeds overwrite each other's edits). */
const DEFAULTABLE = new Set(["mode", "features", "autorun", "theme", "family", "fonts", "readonly", "expand", "status", "vars", "load", "height", "src"]);
/** Defaults a running embed takes without reloading; the others only reach embeds that haven't started yet. */
const LIVE = new Set(["theme", "family", "vars", "mode", "height"]);
/** How long a start may take before the poster offers to try again (a first start downloads several MB of wasm). */
const START_TIMEOUT = 60_000;
const HEIGHTS: Record<string, string> = { code: "auto", console: "360px", preview: "420px", full: "600px", result: "420px" };
const CSS = `:host{display:block;position:relative}
dialog{position:static;display:block;margin:0;padding:0;border:0;width:auto;height:auto;max-width:none;max-height:none;background:none;color:inherit;overflow:visible}
dialog:not([open]){display:none}
dialog:modal{position:fixed;inset:0;margin:auto;width:min(1280px,calc(100vw - 48px));height:calc(100vh - 48px);border-radius:10px;overflow:hidden;box-shadow:0 24px 80px rgb(0 0 0/.5)}
dialog:modal .box{height:100%!important}
dialog::backdrop{background:rgb(0 0 0/.55)}
.box{position:relative;overflow:hidden}
iframe{position:absolute;inset:0;display:block;width:100%;height:100%;border:0}
iframe.wait{visibility:hidden}
.overlay{position:absolute;inset:0;z-index:2;pointer-events:none}
.poster{position:absolute;inset:0;overflow:auto;color-scheme:light dark;background:var(--poster-bg,Canvas);color:var(--poster-fg,CanvasText)}
.poster[hidden]{display:none}
.def{display:block;position:relative;min-height:100%;box-sizing:border-box}
pre{margin:0;padding:12px 16px;font:13px/1.5 var(--font-mono,ui-monospace,Menlo,Consolas,monospace);white-space:pre-wrap}
.play{position:absolute;right:12px;bottom:12px;z-index:1;font:var(--play-font,inherit);padding:6px 14px;border:1px solid var(--play-border,GrayText);border-radius:var(--play-radius,6px);background:var(--play-bg,ButtonFace);color:var(--play-fg,ButtonText);cursor:pointer}
.play:hover{background:var(--play-bg-hover,color-mix(in srgb,var(--play-bg,ButtonFace) 85%,var(--play-fg,ButtonText)))}
.play:focus-visible{outline:2px solid var(--play-bg,Highlight);outline-offset:2px}
.spin{position:absolute;right:16px;bottom:16px;z-index:1;display:none;box-sizing:border-box;width:22px;height:22px;border:2px solid color-mix(in srgb,var(--play-bg,ButtonText) 25%,transparent);border-top-color:var(--play-bg,ButtonText);border-radius:50%;animation:spin .8s linear infinite}
.poster[data-starting] .play{display:none}
.poster[data-starting] .spin{display:block}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}`;

let warned = false;
/** The page's `<bun-playground-defaults>` (the first one). Looked up each time: a client-side navigation may swap it. */
function defaults(): Element | null {
  const all = document.getElementsByTagName("bun-playground-defaults");
  if (all.length > 1 && !warned) (warned = true), console.warn("bun-playground: more than one <bun-playground-defaults>; the first one wins");
  return all[0] ?? null;
}

function parseVars(raw: string | null | undefined): Vars | undefined {
  if (!raw) return undefined;
  try {
    const vars = JSON.parse(raw);
    return vars && typeof vars === "object" ? (vars as Vars) : undefined;
  } catch {
    return undefined;
  }
}

/** Applies a changed page default to an embed that doesn't override it (set in BunPlayground's static block). */
let applyDefault: (el: BunPlayground, name: string) => void;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Drops leading/trailing blank lines and the common leading whitespace. */
function dedent(s: string): string {
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(ind)).join("\n");
}

export class BunPlayground extends HTMLElement {
  static observedAttributes = [...PARAMS, "vars", "share", "load", "height", "src", "title"];

  #root = this.attachShadow({ mode: "open" });
  // The box sits in a dialog that's open in place; expanding reopens it as a modal (the top layer), so the iframe never
  // moves in the DOM, which would reload it.
  #dialog = document.createElement("dialog");
  #box = document.createElement("div");
  #poster = document.createElement("div");
  /** Empty, click-through, above the poster and the frame: a page draws over the embed with `::part(overlay)`. */
  #overlay = document.createElement("div");
  #frame: HTMLIFrameElement | null = null;
  #origin = "";
  #act: Promise<void> | null = null;
  #ready!: Promise<void>;
  #done!: () => void;
  #isReady = false;
  #pending = new Map<number, Pending>();
  #id = 0;
  #io: IntersectionObserver | null = null;
  /** The frame's page said `boot`; until it does, a loaded frame is something else (see #start). */
  #booted = false;
  #listening = false;
  #startTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.#newReady();
    this.#box.className = "box";
    this.#poster.className = "poster";
    this.#poster.innerHTML = `<slot name="poster"></slot>`;
    this.#overlay.className = "overlay";
    this.#overlay.part.add("overlay");
    const style = document.createElement("style");
    style.textContent = CSS;
    this.#box.append(this.#poster, this.#overlay);
    this.#dialog.append(this.#box);
    this.#dialog.setAttribute("open", "");
    // Escape on the host page (focus outside the frame) closes the modal back into the page.
    this.#dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      void this.collapse();
    });
    this.#root.append(style, this.#dialog);
  }

  /** Resolves once the embed is ready (or reported `unsupported`). Created up front; replaced if the iframe is rebuilt. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Creates the iframe (idempotent) and resolves when the embed is ready. */
  activate(): Promise<void> {
    return (this.#act ??= this.#start());
  }

  connectedCallback() {
    if (!this.#listening) addEventListener("message", this.#onMessage), (this.#listening = true);
    this.#renderPoster();
    this.#sizeBox();
    const load = this.#get("load");
    if (this.#act) return;
    if (load === "eager") void this.activate();
    else if (load === "click") return;
    else if (typeof IntersectionObserver === "undefined") void this.activate();
    else {
      this.#io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) this.#io?.disconnect(), (this.#io = null), void this.activate();
      }, { rootMargin: "200px" });
      this.#io.observe(this);
    }
  }

  disconnectedCallback() {
    this.#io?.disconnect();
    this.#io = null;
    removeEventListener("message", this.#onMessage);
    this.#listening = false;
  }

  static {
    applyDefault = (el, name) => {
      // `vars` merges with the embed's own, so it applies even when the embed sets it.
      if (!el.isConnected || (name !== "vars" && el.hasAttribute(name)) || (el.#frame && !LIVE.has(name))) return;
      el.#apply(name);
    };
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    // Removing an attribute falls back to the page default: only a change in the effective value counts.
    const d = DEFAULTABLE.has(name) ? (defaults()?.getAttribute(name) ?? null) : null;
    if ((old ?? d) === (value ?? d) || !this.isConnected) return;
    this.#apply(name);
  }

  /** Applies the effective value of `name` (the attribute, else the page default). */
  #apply(name: string) {
    if (!this.#frame) {
      if (name === "load") (this.#io?.disconnect(), (this.#io = null), this.connectedCallback());
      else this.#sizeBox();
      return;
    }
    if (name === "mode") void this.setMode(this.#get("mode") as Mode);
    else if (name === "theme") void this.setTheme(this.#get("theme") ?? "auto");
    else if (name === "family") void this.setFamily(this.#get("family") ?? "");
    else if (name === "vars") void this.setVars(this.#vars());
    else if (name === "height") this.#sizeBox();
    else if (name !== "title" && name !== "load") this.#rebuild();
    else if (name === "title") this.#frame.title = this.getAttribute("title") || "Bun playground";
  }

  /** Runs the project (optionally from another entry file). */
  run(entry?: string) {
    return this.#call("run", entry === undefined ? undefined : { entry });
  }
  /** Stops a running program. */
  stop() {
    return this.#call("stop");
  }
  /** Runs the install step. */
  install() {
    return this.#call("install");
  }
  /** Runs tests (all, or the given files); resolves with the embed's result. */
  test(files?: string[]) {
    return this.#call("test", files ? { files } : undefined);
  }
  /** Reads a file's text. */
  readFile(path: string): Promise<string> {
    return this.#call("readFile", { path });
  }
  /** Writes a file's text. */
  writeFile(path: string, text: string) {
    return this.#call("writeFile", { path, text });
  }
  /** Lists the project's files. */
  listFiles(): Promise<string[]> {
    return this.#call("listFiles");
  }
  /** Opens a file in the editor. */
  openFile(path: string) {
    return this.#call("openFile", { path });
  }
  /** Switches the layout mode. */
  setMode(mode: Mode) {
    return this.#call("setMode", { mode });
  }
  /** Turns features on or off. */
  setFeatures(features: Partial<Record<Feature, boolean>>) {
    return this.#call("setFeatures", features);
  }
  /** Sets the theme (auto, light, dark, or a theme family by its light variant). */
  setTheme(theme: string) {
    return this.#call("setTheme", { theme });
  }
  /** Sets a theme family (by its light variant) without changing the color mode. */
  setFamily(family: string) {
    return this.#call("setFamily", { family });
  }
  /** Sets the chrome's CSS variables (the `vars` attribute, as an object). */
  setVars(vars: Vars | undefined) {
    return this.#call("setVars", { vars });
  }
  /** Shows the embed in a modal over the page (in the `expand` attribute's mode, if it names one). */
  expand() {
    return this.#setExpanded(true);
  }
  /** Puts a modal embed back in the page. */
  collapse() {
    return this.#setExpanded(false);
  }
  /** True while the embed shows in a modal. */
  get expanded(): boolean {
    return this.#dialog.matches(":modal");
  }

  async #setExpanded(open: boolean) {
    if (open === this.expanded) return;
    await this.activate();
    this.#dialog.close();
    if (open) this.#dialog.showModal();
    else this.#dialog.show();
    this.dispatchEvent(new CustomEvent("bun-playground:expand", { detail: { open }, bubbles: true, composed: true }));
    await this.#request("setExpanded", { open });
  }

  /** Returns a runbun.dev URL that reopens the current project. */
  getShareUrl(): Promise<string> {
    return this.#call("getShareUrl");
  }

  #newReady() {
    this.#isReady = false;
    this.#ready = new Promise<void>((r) => (this.#done = r));
  }

  /** An attribute, else (for DEFAULTABLE keys) the page's `<bun-playground-defaults>` one. */
  #get(name: string): string | null {
    return this.getAttribute(name) ?? (DEFAULTABLE.has(name) ? (defaults()?.getAttribute(name) ?? null) : null);
  }

  #base(): URL {
    return new URL(this.#get("src") || defaultSrc, location.href);
  }

  #bool(name: string): string | null {
    const v = this.#get(name);
    return v === null ? null : v === "false" ? "false" : "true";
  }

  #files(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const s of this.querySelectorAll(":scope > script[data-file]"))
      // `<\/script` and `<\!--` are how a page writes those inside a script element (docs/src/remark-playground.mjs does).
      files[s.getAttribute("data-file")!] = dedent(s.textContent ?? "").replace(/<\\\/script/gi, "</script").replace(/<\\!--/g, "<!--");
    return files;
  }

  /** The `vars` attribute: a JSON object (see protocol.ts Vars) merged per scheme over the page default's. Malformed JSON
   * is ignored like other bad values (that layer is skipped). */
  #vars(): Vars | undefined {
    const layers = [parseVars(defaults()?.getAttribute("vars")), parseVars(this.getAttribute("vars"))].filter((l) => !!l);
    if (!layers.length) return undefined;
    const vars: Vars = {};
    for (const k of ["base", "light", "dark"] as const) for (const l of layers) if (l[k]) vars[k] = { ...vars[k], ...l[k] };
    return vars;
  }

  #url(): URL {
    const base = this.#base();
    const url = new URL("embed", base);
    for (const p of PARAMS) {
      const v = p === "readonly" || p === "autorun" ? this.#bool(p) : this.#get(p);
      if (v !== null) url.searchParams.set(p, v);
    }
    url.searchParams.set("init", "1");
    const share = this.getAttribute("share");
    if (share) url.hash = share.includes("#") ? share.slice(share.indexOf("#")) : share.startsWith("code=") ? "#" + share : share;
    return url;
  }

  #mode(): string {
    const m = this.#get("mode") ?? "code";
    return HEIGHTS[m] ? m : "code";
  }

  /** The poster: a `poster` slot child, or (load=click) a default one built from the first inline file. */
  #renderPoster() {
    this.#poster.querySelector(".def")?.remove();
    this.#poster.querySelector(".play")?.remove();
    this.#poster.querySelector(".spin")?.remove();
    // Any poster that waits for a click says so.
    if (this.#get("load") === "click") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "play";
      btn.textContent = "▶ Run";
      // Only the button starts it: the poster's code stays selectable. After a start timed out, it starts over.
      btn.addEventListener("click", () => (this.#poster.hasAttribute("data-failed") ? this.#rebuild() : void this.activate()));
      // In the button's place from the click until the embed is ready (the poster hides then).
      const spin = document.createElement("span");
      spin.className = "spin";
      spin.setAttribute("role", "status");
      spin.innerHTML = `<span class="sr"></span>`;
      this.#poster.append(btn, spin);
    }
    if (this.querySelector(':scope > [slot="poster"]') || this.#get("load") !== "click") return;
    const def = document.createElement("div");
    def.className = "def";
    const pre = document.createElement("pre");
    pre.textContent = Object.values(this.#files())[0] ?? "Bun playground";
    def.append(pre);
    this.#poster.prepend(def);
  }

  /**
   * The poster's content height, rounded up: scrollHeight rounds to the nearest pixel, and a box half a pixel short of
   * its content scrolls. (Still at least scrollHeight, which counts margins the boxes don't.)
   */
  #posterHeight(): number {
    const top = this.#poster.getBoundingClientRect().top - this.#poster.scrollTop;
    const parts = [...this.#poster.querySelectorAll("slot")].flatMap((s) => s.assignedElements());
    parts.push(...this.#poster.querySelectorAll(".def"));
    return Math.max(this.#poster.scrollHeight, ...parts.map((e) => Math.ceil(e.getBoundingClientRect().bottom - top)));
  }

  #sizeBox(auto?: number) {
    const h = this.#get("height") || HEIGHTS[this.#mode()]!;
    let css = h;
    if (h === "auto") {
      const px = auto ?? (this.#frame && this.#isReady ? this.#box.offsetHeight : this.#posterHeight() || 200);
      // A poster is as tall as its content, so a one-line block keeps its Run button on it; the live embed gets at
      // least room for its bar and a line of output.
      const min = this.#poster.hidden ? 120 : 0;
      css = Math.min(640, Math.max(min, px)) + "px";
    }
    this.#box.style.height = css;
  }

  #rebuild() {
    this.#frame?.remove();
    this.#frame = null;
    this.#act = null;
    for (const p of this.#pending.values()) p.reject(new Error("embed reloaded"));
    this.#pending.clear();
    this.#newReady();
    this.#poster.hidden = false;
    void this.activate();
  }

  #start(): Promise<void> {
    this.#poster.toggleAttribute("data-starting", true);
    this.#poster.removeAttribute("data-failed");
    const btn = this.#poster.querySelector(".play");
    if (btn) btn.textContent = "▶ Run";
    // No `ready` in time: the button comes back to try again (a late `ready` still shows the embed).
    clearTimeout(this.#startTimer);
    this.#startTimer = setTimeout(() => {
      if (this.#isReady) return;
      this.#poster.removeAttribute("data-starting");
      this.#poster.toggleAttribute("data-failed", true);
      if (btn) btn.textContent = "↻ Try again";
    }, START_TIMEOUT);
    // Said once it's shown, so screen readers announce it.
    const sr = this.#poster.querySelector(".spin .sr");
    if (sr) sr.textContent = "Starting…";
    this.#io?.disconnect();
    this.#io = null;
    const url = this.#url();
    this.#origin = url.origin;
    this.#sizeBox(this.#poster.hidden ? undefined : this.#posterHeight());
    const f = document.createElement("iframe");
    f.className = "wait";
    f.allow = "cross-origin-isolated; clipboard-write";
    f.title = this.getAttribute("title") || "Bun playground";
    f.src = url.href;
    // A service worker from before the embed existed sends the frame to its preview page instead (it's updated by that
    // very navigation): a frame that loads without saying `boot` loads again, a few times, as the new worker takes over.
    this.#booted = false;
    let retries = 0;
    f.addEventListener("load", () => {
      setTimeout(() => {
        if (this.#booted || this.#frame !== f || retries >= 3) return;
        retries++;
        f.src = url.href;
      }, 1500 * (retries + 1));
    });
    this.#frame = f;
    this.#box.append(f);
    return this.#ready;
  }

  #send(msg: object) {
    this.#frame?.contentWindow?.postMessage({ [TAG]: VERSION, ...msg }, this.#origin);
  }

  async #call(method: Request["method"], params?: unknown): Promise<any> {
    await this.activate();
    return this.#request(method, params);
  }

  #request(method: string, params?: unknown): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ id, method, params });
    });
  }

  #onMessage = (e: MessageEvent) => {
    const d = e.data;
    if (!this.#frame || e.source !== this.#frame.contentWindow || e.origin !== this.#origin || d?.[TAG] !== VERSION) return;
    if (typeof d.id === "number" && !d.event) {
      const p = this.#pending.get(d.id);
      if (!p) return;
      this.#pending.delete(d.id);
      const r = d as Reply;
      r.error !== undefined ? p.reject(new Error(r.error)) : p.resolve(r.result);
      return;
    }
    const { event, data } = d as Event;
    // The embed's expand button: the element opens or closes the modal and announces it itself.
    if (event === "expand") return void this.#setExpanded(data.open);
    if (event === "boot") {
      this.#booted = true;
      void this.#request("init", { files: this.#files(), options: {}, vars: this.#vars() }).catch(() => {});
    } else if (event === "ready" || event === "unsupported") {
      this.#isReady = true;
      this.#frame.classList.remove("wait");
      this.#poster.hidden = true;
      this.#poster.removeAttribute("data-starting");
      clearTimeout(this.#startTimer);
      this.#done();
    } else if (event === "resize" && (this.#get("height") || HEIGHTS[this.#mode()]) === "auto") this.#sizeBox(data.height);
    this.dispatchEvent(new CustomEvent("bun-playground:" + event, { detail: data, bubbles: true, composed: true }));
  };
}

/** `<bun-playground-defaults>`: page-wide defaults for every `<bun-playground>` (same attribute names and parsing). An
 * embed's own attribute wins; a changed default reaches running embeds live for LIVE keys, else only embeds not started. */
export class BunPlaygroundDefaults extends HTMLElement {
  static observedAttributes = [...DEFAULTABLE];

  connectedCallback() {
    this.style.display = "none";
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (old === value || !this.isConnected || defaults() !== this) return;
    for (const el of document.getElementsByTagName("bun-playground")) if (el instanceof BunPlayground) applyDefault(el, name);
  }
}

export type DefineOptions = {
  /** The playground that embeds without a `src` frame (default `https://runbun.dev/`), e.g. a local dev server. */
  src?: string | URL;
};

/** Registers `<bun-playground>` and `<bun-playground-defaults>`. A later call only changes `src` for embeds that start later. */
export function define(options: DefineOptions = {}) {
  if (options.src) defaultSrc = new URL(options.src, location.href).href;
  if (!customElements.get("bun-playground-defaults")) customElements.define("bun-playground-defaults", BunPlaygroundDefaults);
  if (!customElements.get("bun-playground")) customElements.define("bun-playground", BunPlayground);
}

declare global {
  interface HTMLElementTagNameMap {
    "bun-playground-defaults": BunPlaygroundDefaults;
    "bun-playground": BunPlayground;
  }
}
