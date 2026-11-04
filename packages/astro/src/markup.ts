// HTML shared by the components and the fence plugin, so a <Code> block and a fence look and load the same.
import { highlight } from "./highlight.js";

export const CSS_PATH = "_runbun/highlights.css";

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const slash = (url: string) => (url.endsWith("/") ? url : url + "/");

/** The stylesheet with the blocks' look and theme colors (a route of the integration's). */
export const cssLink = (base: string) => `<link rel="stylesheet" href="${esc(slash(base) + CSS_PATH)}">`;

/**
 * A highlighted block; `not-content` keeps Starlight's prose styles off it. Its `<pre>` says the language as Expressive
 * Code's does (`data-language`), for tools that turn the page back into Markdown. The Copy button works with
 * copyScript() on the page.
 */
export function codeBlock(code: string, lang: string, title?: string, lines?: BlockLines) {
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : "";
  const html = highlight(code.replace(/\n$/, ""), lang);
  const pre = (hasLines(lines) ? byLine(html, lines) : html).replace(/^<pre /, `<pre data-language="${esc(lang)}" `);
  const copy = `<button type="button" class="runbun-copy" data-runbun-copy aria-label="Copy code" aria-live="polite">Copy</button>`;
  return `<figure class="runbun-code not-content">${caption}${pre}${copy}</figure>`;
}

/** A block's line marks, by 0-based line of the code it shows. */
export interface BlockLines {
  mark?: number[];
  ins?: number[];
  del?: number[];
}
const KINDS = ["mark", "ins", "del"] as const;
const hasLines = (lines?: BlockLines): lines is BlockLines => !!lines && KINDS.some((k) => lines[k]?.length);

/**
 * `"1,4-6"` (a fence's `{1,4-6}` without the braces) as 1-based line numbers; a reversed range counts too, as in
 * Expressive Code. Null when it isn't a list of numbers and ranges.
 */
export function lineNumbers(list: string): number[] | null {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(list)) return null;
  return list.split(",").flatMap((part) => {
    const [a, b = a] = part.split("-").map(Number) as [number, number?];
    return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);
  });
}

/** <Code>'s `mark`, `ins` and `del` (`"1, 4-6"`, 1-based) as a block's lines; anything but numbers and ranges throws. */
export function propLines(props: { mark?: string | undefined; ins?: string | undefined; del?: string | undefined }): BlockLines {
  const out: BlockLines = {};
  for (const kind of KINDS) {
    const list = props[kind];
    if (list === undefined) continue;
    const ns = lineNumbers(list.replace(/\s+/g, ""));
    if (!ns) throw new Error(`@runbun/astro: <Code ${kind}="${list}"> takes line numbers and ranges, like "1,4-6"`);
    out[kind] = ns.map((n) => n - 1).filter((i) => i >= 0);
  }
  return out;
}

/**
 * highlight()'s `<pre>` with each line in a `<span class="line">` (`data-mark`, `data-ins`, `data-del`), for marks
 * whose background spans the line. One highlighter path: the token spans are cut where a line ends (closed, then
 * reopened on the next line), which needs them flat, as highlights' are (a test guards it). The `\n` text stays
 * between the lines, so the code's text is the source as it was.
 */
function byLine(pre: string, lines: BlockLines): string {
  const start = pre.indexOf("<code>") + "<code>".length;
  const stop = pre.lastIndexOf("</code>");
  const line = (i: number) => `<span class="line"${KINDS.filter((k) => lines[k]?.includes(i)).map((k) => ` data-${k}`).join("")}>`;
  let i = 0;
  let open = "";
  let out = line(0);
  for (const part of pre.slice(start, stop).split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") out += (open && "</span>") + `</span>\n${line(++i)}${open}`;
    else if (part === "</span>") (out += part), (open = "");
    else if (part.startsWith("<span")) {
      if (open) throw new Error("@runbun/astro: the highlighter nested its spans; lines can't be split");
      out += open = part;
    } else out += part;
  }
  // A token cut at a line's end leaves an empty copy on the next line (`// x\n\n` is one span).
  out = (out + "</span>").replace(/<span style="[^"]*"><\/span>/g, "");
  return `${pre.slice(0, start - 1)} class="runbun-lines">${out}${pre.slice(stop)}`;
}

/**
 * The Copy buttons' behaviour: one click listener on the document, for every block (later ones included, after a
 * client-side navigation), registered once however often the script runs. It copies the code element's text, which is
 * the block's source exactly (the highlighter only wraps it in spans), and says "Copied" for a moment; where the
 * clipboard isn't available it selects the code instead. A click on Copy in a poster doesn't start the embed: only its
 * Run button does.
 */
export const copyScript = () =>
  `<script type="module" data-runbun-copy-script>if(!window.__runbunCopy){window.__runbunCopy=1;` +
  `const set=(b,t,l)=>{b.textContent=t;b.setAttribute("aria-label",l)};` +
  `document.addEventListener("click",async(e)=>{const b=e.target instanceof Element&&e.target.closest("[data-runbun-copy]");` +
  `const c=b&&b.closest(".runbun-code")?.querySelector("pre code");if(!c)return;` +
  `try{await navigator.clipboard.writeText(c.textContent)}catch{getSelection()?.selectAllChildren(c);return}` +
  `set(b,"Copied","Copied");b.toggleAttribute("data-copied",true);clearTimeout(b.runbunCopy);` +
  `b.runbunCopy=setTimeout(()=>{set(b,"Copy","Copy code");b.removeAttribute("data-copied")},1500)})}</script>`;

// Tab groups' radio names must be unique per page. The remark plugin and the components load separate copies of this
// module (Astro bundles them apart), so the counter lives on globalThis, shared by every copy.
const counter = ((globalThis as { [k: symbol]: { n: number } })[Symbol.for("runbun.tabGroups")] ??= { n: 0 });

/**
 * Several files as one block with a tab per file. Plain HTML: the tabs are radio buttons, and the stylesheet shows the
 * file whose tab is checked, so switching needs no script. `selected` names the tab checked first (default: the
 * first). One file is a plain block. A file's `lines` marks its lines (codeBlock).
 */
export function codeTabs(files: { name: string; code: string; lang?: string; lines?: BlockLines }[], selected?: string): string {
  if (files.length === 1) return codeBlock(files[0]!.code, files[0]!.lang ?? langOf(files[0]!.name), files[0]!.name, files[0]!.lines);
  const group = `runbun-tabs-${++counter.n}`;
  const checked = Math.max(0, files.findIndex((f) => f.name === selected));
  const tabs = files
    .map((f, i) => `<label><input type="radio" name="${group}"${i === checked ? " checked" : ""}>${esc(f.name)}</label>`)
    .join("");
  const panels = files.map((f) => codeBlock(f.code, f.lang ?? langOf(f.name), undefined, f.lines)).join("");
  return `<div class="runbun-tabs not-content"><div class="runbun-tablist" aria-label="Files">${tabs}</div>${panels}</div>`;
}

/** A highlights language for a file name: its extension. */
export const langOf = (name: string) => name.slice(name.lastIndexOf(".") + 1) || "plain";

/** `features` with the embed's tab bar on, unless the author's list already says either way. */
export const withTabs = (features?: string): string => (/(^|,)\s*-?tabs\s*(,|$)/.test(features ?? "") ? (features as string) : [features, "tabs"].filter(Boolean).join(","));

/**
 * A file as an inline source of a <bun-playground>: `<\/script` and `<\!--` are how it is written inside a script.
 * `hidden` (a file the package generated) keeps it out of the embed's tabs.
 */
export function fileScript(path: string, text: string, hidden = false) {
  const body = text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  return `<script type="text/plain" data-file="${esc(path)}"${hidden ? " data-hidden" : ""}>\n${body}\n</script>`;
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
