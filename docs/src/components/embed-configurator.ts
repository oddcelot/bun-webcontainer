// The configurator's client side (EmbedConfigurator.astro): turns the form into <bun-playground> attributes, writes the
// element and iframe snippets, and keeps a live embed in step.

type Config = { playground: string; presets: Record<string, readonly string[]> };

const root = document.querySelector<HTMLElement>(".cfg")!;
const { playground, presets } = JSON.parse(root.dataset.config!) as Config;
const form = root.querySelector("form")!;
const preview = root.querySelector<HTMLElement>(".preview")!;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const featureBoxes = [...form.querySelectorAll<HTMLInputElement>('input[name="feature"]')];
const HEIGHTS: Record<string, string> = { code: "auto", console: "360px", preview: "420px", full: "600px", result: "420px" };

/** The attributes the form adds up to, in a stable order, defaults left out. "" is a bare boolean attribute. */
function attrs(): [string, string][] {
  const v = (name: string) => field(name).value.trim();
  const out: [string, string][] = [];
  const add = (name: string, value: string, skip = "") => value !== skip && out.push([name, value]);
  const source = v("source");
  if (source === "example") add("example", v("example"));
  if (source === "repo") add("repo", v("repo"));
  const mode = v("mode");
  out.push(["mode", mode]);
  const preset = new Set(presets[mode]);
  add("features", featureBoxes.flatMap((b) => (b.checked === preset.has(b.value) ? [] : [b.checked ? b.value : `-${b.value}`])).join(","));
  add("file", v("file"));
  add("path", v("path"));
  add("autorun", v("autorun"));
  add("load", v("load"), "visible");
  add("height", v("height"));
  const expand = v("expand");
  if (expand !== "none") out.push(["expand", expand === "button" ? "" : expand]);
  add("status", v("status"), "toast");
  if (field("readonly").checked) out.push(["readonly", ""]);
  add("persist", v("persist"));
  add("theme", v("theme"), "auto");
  add("family", v("family"));
  add("fonts", v("fonts"));
  const base: Record<string, string> = {};
  if (field("accentOn").checked) base["--accent"] = v("accent");
  if (v("radius")) base["--radius"] = v("radius");
  if (v("fontUi")) base["--font-ui"] = v("fontUi");
  if (v("fontMono")) base["--font-mono"] = v("fontMono");
  if (Object.keys(base).length) out.push(["vars", JSON.stringify({ base })]);
  add("title", v("title"));
  return out;
}

const inline = () => (field("source").value === "inline" ? { path: field("filename").value.trim() || "index.ts", text: field("code").value } : null);

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** `name`, `name="value"`, or single quotes when the value holds double quotes (vars JSON). */
const attr = ([name, value]: [string, string]) =>
  value === "" ? name : value.includes('"') ? `${name}='${escAttr(value).replace(/'/g, "&#39;")}'` : `${name}="${escAttr(value)}"`;
const escScript = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const indent = (s: string, pad: string) => s.replace(/\n+$/, "").split("\n").map((l) => (l ? pad + l : l)).join("\n");

function elementSnippet(list: [string, string][]) {
  const file = inline();
  const open = list.length > 2 ? `<bun-playground\n${list.map((a) => "  " + attr(a)).join("\n")}\n>` : `<bun-playground${list.map((a) => " " + attr(a)).join("")}>`;
  const body = file ? `\n  <script type="text/plain" data-file="${escAttr(file.path)}">\n${indent(escScript(file.text), "    ")}\n  </script>\n` : "";
  return `<script type="module" src="${playground}embed.js"></script>\n\n${open}${body}</bun-playground>`;
}

// An inline file reaches an iframe as a share link's hash: { v: 1, files } as JSON, deflate-raw, base64url.
async function shareHash(files: Record<string, string>) {
  const stream = new Blob([JSON.stringify({ v: 1, files })]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "#code=" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ELEMENT_ONLY = new Set(["vars", "load", "height", "title"]);
async function iframeSnippet(list: [string, string][]) {
  const params = new URLSearchParams(list.filter(([k]) => !ELEMENT_ONLY.has(k)));
  const file = inline();
  const hash = file ? await shareHash({ [file.path]: file.text }) : "";
  const map = new Map(list);
  let height = map.get("height") || HEIGHTS[map.get("mode")!]!;
  const notes: string[] = [];
  if (height === "auto") (height = "360px"), notes.push("An iframe doesn't fit its content: listen for the resize event, or set a height.");
  if (map.has("vars")) notes.push("vars is element-only: send it over postMessage with setVars.");
  const title = map.get("title");
  const src = `${playground}embed${params.size ? "?" + params : ""}${hash}`;
  return [
    ...notes.map((n) => `<!-- ${n} -->`),
    `<iframe\n  src="${escAttr(src)}"${title ? `\n  title="${escAttr(title)}"` : ""}\n  allow="cross-origin-isolated; clipboard-write"\n  style="width: 100%; height: ${height}; border: 0"\n></iframe>`,
  ].join("\n");
}

// The live embed. Attribute changes go to the running element (it updates in place or rebuilds its frame); a changed
// file or source makes a new element, since the inline files are only read at start.
let live: HTMLElement | null = null;
let liveKey = "";
let liveAttrs = new Map<string, string>();
function updatePreview(list: [string, string][]) {
  const file = inline();
  const key = JSON.stringify([field("source").value, file, list.find(([k]) => k === "example" || k === "repo")]);
  const next = new Map(list);
  if (!live || key !== liveKey) {
    live = document.createElement("bun-playground");
    for (const [k, v] of next) live.setAttribute(k, v);
    if (file) {
      const s = document.createElement("script");
      s.type = "text/plain";
      s.dataset.file = file.path;
      s.textContent = file.text;
      live.append(s);
    }
    preview.replaceChildren(live);
    liveKey = key;
  } else {
    for (const k of liveAttrs.keys()) if (!next.has(k)) live.removeAttribute(k);
    for (const [k, v] of next) if (liveAttrs.get(k) !== v) live.setAttribute(k, v);
  }
  liveAttrs = next;
}

let presetMode = "";
let timer: ReturnType<typeof setTimeout> | undefined;
async function update(immediate = false) {
  // A new mode starts from its own feature preset.
  const mode = field("mode").value;
  if (mode !== presetMode) {
    const on = new Set(presets[mode]);
    for (const b of featureBoxes) b.checked = on.has(b.value);
    presetMode = mode;
  }
  for (const el of form.querySelectorAll<HTMLElement>("[data-for]")) el.hidden = el.dataset.for !== field("source").value;
  const list = attrs();
  root.querySelector('[data-out="element"] code')!.textContent = elementSnippet(list);
  clearTimeout(timer);
  if (immediate) updatePreview(list);
  else timer = setTimeout(() => updatePreview(attrs()), 500);
  root.querySelector('[data-out="iframe"] code')!.textContent = await iframeSnippet(list);
}

form.addEventListener("input", () => void update());
form.addEventListener("submit", (e) => e.preventDefault());

const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
for (const tab of tabs)
  tab.addEventListener("click", () => {
    for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
    for (const pre of root.querySelectorAll<HTMLElement>("[data-out]")) pre.hidden = pre.dataset.out !== tab.dataset.tab;
  });
const copy = root.querySelector<HTMLButtonElement>(".copy")!;
copy.addEventListener("click", async () => {
  const shown = root.querySelector<HTMLElement>("[data-out]:not([hidden]) code")!;
  await navigator.clipboard.writeText(shown.textContent ?? "");
  copy.textContent = "Copied";
  setTimeout(() => (copy.textContent = "Copy"), 1500);
});

void update(true);
