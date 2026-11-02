import { deflateSync, strToU8 } from "fflate";
import { PRESETS } from "../embed/config";
import type { Feature, Mode } from "../embed/protocol";

// What the configurator's form adds up to: the <bun-playground> attributes, and the element and iframe snippets a page
// pastes. Plain functions over the form's state; Configurator.tsx renders them.

export type Source = "inline" | "example" | "repo";
export type Form = {
  source: Source;
  filename: string;
  code: string;
  example: string;
  repo: string;
  mode: Mode;
  /** The features that are on; a preset feature left out is locked off (`-name`). */
  features: Feature[];
  height: string;
  /** "none", "button", or the mode to switch to. */
  expand: string;
  status: "toast" | "bar";
  load: "visible" | "eager" | "click";
  /** "default" (the mode's), "true" or "false". */
  autorun: string;
  file: string;
  path: string;
  persist: string;
  title: string;
  readonly: boolean;
  theme: "auto" | "light" | "dark";
  /** A family's light variant, or "default". */
  family: string;
  /** An accent color, or "" for the theme's. */
  accent: string;
  radius: string;
  fontUi: string;
  fontMono: string;
  fonts: string;
};

/** A name and a value; "" is a bare boolean attribute. */
export type Attr = [name: string, value: string];

/** The default heights per mode (embed-element/index.ts), for the iframe, which can't fit its content. */
const HEIGHTS: Record<Mode, string> = { code: "auto", console: "360px", preview: "420px", full: "600px", result: "420px" };
/** Attributes the iframe's URL doesn't take. */
const ELEMENT_ONLY = new Set(["vars", "load", "height", "title"]);

/** The `features` list: what differs from the mode's preset. */
export function featureList(mode: Mode, on: readonly Feature[]): string {
  const preset = new Set(PRESETS[mode]);
  const set = new Set(on);
  return [...on.filter((f) => !preset.has(f)), ...PRESETS[mode].filter((f) => !set.has(f)).map((f) => `-${f}`)].join(",");
}

/** The attributes in a stable order, defaults left out. */
export function attributes(f: Form): Attr[] {
  const out: Attr[] = [];
  const add = (name: string, value: string, skip = "") => {
    const v = value.trim();
    if (v !== skip) out.push([name, v]);
  };
  if (f.source === "example") add("example", f.example);
  if (f.source === "repo") add("repo", f.repo);
  out.push(["mode", f.mode]);
  add("features", featureList(f.mode, f.features));
  add("file", f.file);
  add("path", f.path);
  add("autorun", f.autorun, "default");
  add("load", f.load, "visible");
  add("height", f.height);
  if (f.expand !== "none") out.push(["expand", f.expand === "button" ? "" : f.expand]);
  add("status", f.status, "toast");
  if (f.readonly) out.push(["readonly", ""]);
  add("persist", f.persist);
  add("theme", f.theme, "auto");
  add("family", f.family, "default");
  add("fonts", f.fonts);
  const base: Record<string, string> = {};
  if (f.accent) base["--accent"] = f.accent;
  if (f.radius.trim()) base["--radius"] = f.radius.trim();
  if (f.fontUi.trim()) base["--font-ui"] = f.fontUi.trim();
  if (f.fontMono.trim()) base["--font-mono"] = f.fontMono.trim();
  if (Object.keys(base).length) out.push(["vars", JSON.stringify({ base })]);
  add("title", f.title);
  return out;
}

/** The inline file, when the source is one. */
export const inlineFile = (f: Form) => (f.source === "inline" ? { path: f.filename.trim() || "index.ts", text: f.code } : null);

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** `name`, `name="value"`, or single quotes when the value holds double quotes (the vars JSON). */
const attr = ([name, value]: Attr) =>
  value === "" ? name : value.includes('"') ? `${name}='${escAttr(value).replace(/'/g, "&#39;")}'` : `${name}="${escAttr(value)}"`;
const escScript = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const indent = (s: string, pad: string) =>
  s
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");

/** The script tag and the element, with the inline file as a `<script type="text/plain">` child. */
export function elementSnippet(f: Form, list: Attr[], playground: string): string {
  const file = inlineFile(f);
  const open =
    list.length > 2 ? `<bun-playground\n${list.map((a) => "  " + attr(a)).join("\n")}\n>` : `<bun-playground${list.map((a) => " " + attr(a)).join("")}>`;
  const body = file ? `\n  <script type="text/plain" data-file="${escAttr(file.path)}">\n${indent(escScript(file.text), "    ")}\n  </script>\n` : "";
  return `<script type="module" src="${playground}embed.js"></script>\n\n${open}${body}</bun-playground>`;
}

/** A share link's hash (share.ts): `{ v: 1, files }` as JSON, raw deflate, base64url. */
function shareHash(files: Record<string, string>): string {
  const bytes = deflateSync(strToU8(JSON.stringify({ v: 1, files })));
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "#code=" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The iframe: the same options as URL parameters, an inline file as a share link's hash. */
export function iframeSnippet(f: Form, list: Attr[], playground: string): string {
  const params = new URLSearchParams(list.filter(([k]) => !ELEMENT_ONLY.has(k)));
  const file = inlineFile(f);
  const map = new Map(list);
  let height = map.get("height") || HEIGHTS[f.mode];
  const notes: string[] = [];
  if (height === "auto") (height = "360px"), notes.push("An iframe doesn't fit its content: listen for the resize event, or set a height.");
  if (map.has("vars")) notes.push("vars is element-only: send it over postMessage with setVars.");
  const title = map.get("title");
  const src = `${playground}embed${params.size ? "?" + params : ""}${file ? shareHash({ [file.path]: file.text }) : ""}`;
  return [
    ...notes.map((n) => `<!-- ${n} -->`),
    `<iframe\n  src="${escAttr(src)}"${title ? `\n  title="${escAttr(title)}"` : ""}\n  allow="cross-origin-isolated; clipboard-write"\n  style="width: 100%; height: ${height}; border: 0"\n></iframe>`,
  ].join("\n");
}
