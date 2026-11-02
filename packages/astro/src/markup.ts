// HTML shared by the components and the fence plugin, so a <Code> block and a fence look and load the same.
import { highlight } from "./highlight.js";

export const CSS_PATH = "_runbun/highlights.css";

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const slash = (url: string) => (url.endsWith("/") ? url : url + "/");

/** The stylesheet with the blocks' look and theme colors (a route of the integration's). */
export const cssLink = (base: string) => `<link rel="stylesheet" href="${esc(slash(base) + CSS_PATH)}">`;

/** A highlighted block; `not-content` keeps Starlight's prose styles off it. */
export function codeBlock(code: string, lang: string, title?: string) {
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : "";
  return `<figure class="runbun-code not-content">${caption}${highlight(code.replace(/\n$/, ""), lang)}</figure>`;
}

// Tab groups' radio names must be unique per page. The remark plugin and the components load separate copies of this
// module (Astro bundles them apart), so the counter lives on globalThis, shared by every copy.
const counter = ((globalThis as { [k: symbol]: { n: number } })[Symbol.for("runbun.tabGroups")] ??= { n: 0 });

/**
 * Several files as one block with a tab per file. Plain HTML: the tabs are radio buttons, and the stylesheet shows the
 * file whose tab is checked, so switching needs no script. `selected` names the tab checked first (default: the
 * first). One file is a plain block.
 */
export function codeTabs(files: { name: string; code: string; lang?: string }[], selected?: string): string {
  if (files.length === 1) return codeBlock(files[0]!.code, files[0]!.lang ?? langOf(files[0]!.name), files[0]!.name);
  const group = `runbun-tabs-${++counter.n}`;
  const checked = Math.max(0, files.findIndex((f) => f.name === selected));
  const tabs = files
    .map((f, i) => `<label><input type="radio" name="${group}"${i === checked ? " checked" : ""}>${esc(f.name)}</label>`)
    .join("");
  const panels = files.map((f) => codeBlock(f.code, f.lang ?? langOf(f.name))).join("");
  return `<div class="runbun-tabs not-content"><div class="runbun-tablist" aria-label="Files">${tabs}</div>${panels}</div>`;
}

/** A highlights language for a file name: its extension. */
export const langOf = (name: string) => name.slice(name.lastIndexOf(".") + 1) || "plain";

/** `features` with the embed's tab bar on, unless the author's list already says either way. */
export const withTabs = (features?: string): string => (/(^|,)\s*-?tabs\s*(,|$)/.test(features ?? "") ? (features as string) : [features, "tabs"].filter(Boolean).join(","));

/** A file as an inline source of a <bun-playground>: `<\/script` and `<\!--` are how it is written inside a script. */
export function fileScript(path: string, text: string) {
  const body = text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  return `<script type="text/plain" data-file="${esc(path)}">\n${body}\n</script>`;
}

/**
 * The element (embed.js from the playground) and, with `sync`, a script that keeps every embed in the page's scheme
 * and family: `sync.scheme` names the <html> attribute that says `light` or `dark`, `sync.family` the one with the
 * family. Module scripts with the same URL run once, so a page loads embed.js a single time however many embeds it has.
 */
export function embedScripts(playgroundUrl: string, sync?: { scheme?: string; family?: string }): string {
  let out = `<script type="module" src="${esc(slash(playgroundUrl))}embed.js"></script>`;
  if (sync?.scheme || sync?.family) {
    const { scheme, family } = JSON.parse(JSON.stringify(sync));
    out +=
      `<script type="module">const s=${JSON.stringify(scheme ?? null)},f=${JSON.stringify(family ?? null)},h=document.documentElement;` +
      `const sync=()=>{for(const el of document.querySelectorAll("bun-playground")){` +
      `if(s)el.setAttribute("theme",h.getAttribute(s)==="light"?"light":"dark");` +
      `const v=f&&h.getAttribute(f);if(v)el.setAttribute("family",v);}};` +
      `sync();new MutationObserver(sync).observe(h,{attributes:true,attributeFilter:[s,f].filter(Boolean)});</script>`;
  }
  return out;
}

/** Extensions for a file named after its fence's or block's language. */
export const EXT: Record<string, string> = { typescript: "ts", javascript: "js", markdown: "md", jsonc: "json", shell: "sh", bash: "sh" };

const INDEX = new Set(["index.ts", "index.tsx", "index.js", "src/index.ts"]);

/**
 * `files` with `entry` as the file Run starts. Run starts package.json's `main`, else an index file, so a block named
 * anything else gets a package.json that points at it (unless the files bring their own). Test files are left alone:
 * `bun test` finds them.
 */
export function withEntry(files: Record<string, string>, entry: string): Record<string, string> {
  if (INDEX.has(entry) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry) || "package.json" in files) return files;
  return { ...files, "package.json": JSON.stringify({ main: entry }, null, 2) + "\n" };
}
