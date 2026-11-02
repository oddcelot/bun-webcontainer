// HTML shared by the components and the fence plugin, so a <Code> block and a fence look and load the same.
import { highlight } from "./highlight.js";

export const CSS_PATH = "_runbun/highlights.css";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const slash = (url) => (url.endsWith("/") ? url : url + "/");

/** The stylesheet with the blocks' look and theme colors (a route of the integration's). */
export const cssLink = (base) => `<link rel="stylesheet" href="${esc(slash(base) + CSS_PATH)}">`;

/** A highlighted block; `not-content` keeps Starlight's prose styles off it. */
export function codeBlock(code, lang, title) {
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : "";
  return `<figure class="runbun-code not-content">${caption}${highlight(code.replace(/\n$/, ""), lang)}</figure>`;
}

/** A file as an inline source of a <bun-playground>: `<\/script` and `<\!--` are how it is written inside a script. */
export function fileScript(path, text) {
  const body = text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  return `<script type="text/plain" data-file="${esc(path)}">\n${body}\n</script>`;
}

/**
 * The element (embed.js from the playground) and, with `sync`, a script that keeps every embed in the page's scheme
 * and family: `sync.scheme` names the <html> attribute that says `light` or `dark`, `sync.family` the one with the
 * family. Module scripts with the same URL run once, so a page loads embed.js a single time however many embeds it has.
 */
export function embedScripts(playgroundUrl, sync) {
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
export const EXT = { typescript: "ts", javascript: "js", markdown: "md", jsonc: "json", shell: "sh", bash: "sh" };
