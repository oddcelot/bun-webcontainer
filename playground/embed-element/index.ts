// <bun-playground>: builds an iframe to <base>embed and talks to it over postMessage (protocol: ../src/embed/protocol.ts).
// Dependency-free; bundled standalone as embed.js. Don't import runtime values from the app.
import type { Event, Feature, Mode, Reply, Request, Vars } from "../src/embed/protocol";

const TAG = "bunPlayground"; // = protocol TAG
const VERSION = 1; // = protocol VERSION

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
];
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
.poster{position:absolute;inset:0;overflow:auto;cursor:pointer;color-scheme:light dark;background:var(--poster-bg,Canvas);color:var(--poster-fg,CanvasText)}
.poster[hidden]{display:none}
.def{display:block;position:relative;min-height:100%;box-sizing:border-box}
pre{margin:0;padding:12px 16px;font:13px/1.5 var(--font-mono,ui-monospace,Menlo,Consolas,monospace);white-space:pre-wrap}
.play{position:absolute;right:12px;bottom:12px;z-index:1;font:var(--play-font,inherit);padding:6px 14px;border:1px solid var(--play-border,GrayText);border-radius:var(--play-radius,6px);background:var(--play-bg,ButtonFace);color:var(--play-fg,ButtonText);cursor:pointer}`;

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

  constructor() {
    super();
    this.#newReady();
    this.#box.className = "box";
    this.#poster.className = "poster";
    this.#poster.innerHTML = `<slot name="poster"></slot>`;
    this.#poster.addEventListener("click", () => void this.activate());
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
    const load = this.getAttribute("load");
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

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (old === value || !this.isConnected) return;
    if (!this.#frame) {
      if (name === "load") (this.#io?.disconnect(), (this.#io = null), this.connectedCallback());
      else this.#sizeBox();
      return;
    }
    if (name === "mode") void this.setMode(value as Mode);
    else if (name === "theme") void this.setTheme(value ?? "auto");
    else if (name === "family") void this.setFamily(value ?? "");
    else if (name === "vars") void this.setVars(this.#vars());
    else if (name === "height") this.#sizeBox();
    else if (name !== "title" && name !== "load") this.#rebuild();
    else if (name === "title") this.#frame.title = value || "Bun playground";
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

  #base(): URL {
    return new URL(this.getAttribute("src") || "./", this.getAttribute("src") ? location.href : import.meta.url);
  }

  #bool(name: string): string | null {
    const v = this.getAttribute(name);
    return v === null ? null : v === "false" ? "false" : "true";
  }

  #files(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const s of this.querySelectorAll(":scope > script[data-file]"))
      // `<\/script` and `<\!--` are how a page writes those inside a script element (docs/src/remark-playground.mjs does).
      files[s.getAttribute("data-file")!] = dedent(s.textContent ?? "").replace(/<\\\/script/gi, "</script").replace(/<\\!--/g, "<!--");
    return files;
  }

  /** The `vars` attribute: a JSON object (see protocol.ts Vars). Malformed JSON is ignored like other bad values. */
  #vars(): Vars | undefined {
    const raw = this.getAttribute("vars");
    if (!raw) return undefined;
    try {
      const vars = JSON.parse(raw);
      return vars && typeof vars === "object" ? (vars as Vars) : undefined;
    } catch {
      return undefined;
    }
  }

  #url(): URL {
    const base = this.#base();
    const url = new URL("embed", base);
    for (const p of PARAMS) {
      const v = p === "readonly" || p === "autorun" ? this.#bool(p) : this.getAttribute(p);
      if (v !== null) url.searchParams.set(p, v);
    }
    url.searchParams.set("init", "1");
    const share = this.getAttribute("share");
    if (share) url.hash = share.includes("#") ? share.slice(share.indexOf("#")) : share.startsWith("code=") ? "#" + share : share;
    return url;
  }

  #mode(): string {
    const m = this.getAttribute("mode") ?? "code";
    return HEIGHTS[m] ? m : "code";
  }

  /** The poster: a `poster` slot child, or (load=click) a default one built from the first inline file. */
  #renderPoster() {
    this.#poster.querySelector(".def")?.remove();
    this.#poster.querySelector(".play")?.remove();
    // Any poster that waits for a click says so.
    if (this.getAttribute("load") === "click") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "play";
      btn.textContent = "▶ Run";
      this.#poster.append(btn);
    }
    if (this.querySelector(':scope > [slot="poster"]') || this.getAttribute("load") !== "click") return;
    const def = document.createElement("div");
    def.className = "def";
    const pre = document.createElement("pre");
    pre.textContent = Object.values(this.#files())[0] ?? "Bun playground";
    def.append(pre);
    this.#poster.prepend(def);
  }

  #sizeBox(auto?: number) {
    const h = this.getAttribute("height") || HEIGHTS[this.#mode()]!;
    let css = h;
    if (h === "auto") {
      const px = auto ?? (this.#frame && this.#isReady ? this.#box.offsetHeight : this.#poster.scrollHeight || 200);
      css = Math.min(640, Math.max(120, px)) + "px";
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
    this.#io?.disconnect();
    this.#io = null;
    const url = this.#url();
    this.#origin = url.origin;
    this.#sizeBox(this.#poster.hidden ? undefined : this.#poster.scrollHeight);
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
      this.#done();
    } else if (event === "resize" && (this.getAttribute("height") || HEIGHTS[this.#mode()]) === "auto") this.#sizeBox(data.height);
    this.dispatchEvent(new CustomEvent("bun-playground:" + event, { detail: data, bubbles: true, composed: true }));
  };
}

if (!customElements.get("bun-playground")) customElements.define("bun-playground", BunPlayground);

declare global {
  interface HTMLElementTagNameMap {
    "bun-playground": BunPlayground;
  }
}
