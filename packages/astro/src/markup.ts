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
  /** HTML at the end of a line, inside it: a note's button (noteButton). */
  end?: Record<number, string>;
}
const KINDS = ["mark", "ins", "del"] as const;
const hasLines = (lines?: BlockLines): lines is BlockLines =>
  !!lines && (KINDS.some((k) => lines[k]?.length) || Object.keys(lines.end ?? {}).length > 0);

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
  const { start, stop, html } = htmlLines(pre);
  const attrs = (i: number) => KINDS.filter((k) => lines[k]?.includes(i)).map((k) => ` data-${k}`).join("");
  const out = html.map((line, i) => `<span class="line"${attrs(i)}>${line}${lines.end?.[i] ?? ""}</span>`).join("\n");
  return `${pre.slice(0, start - 1)} class="runbun-lines">${out}${pre.slice(stop)}`;
}

/** highlight()'s `<pre>` cut into each line's HTML, and where its `<code>`'s content starts and stops. */
function htmlLines(pre: string): { start: number; stop: number; html: string[] } {
  const start = pre.indexOf("<code>") + "<code>".length;
  const stop = pre.lastIndexOf("</code>");
  const html = [""];
  let open = "";
  for (const part of pre.slice(start, stop).split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") (html[html.length - 1] += open && "</span>"), html.push(open);
    else {
      if (part === "</span>") open = "";
      else if (part.startsWith("<span")) {
        if (open) throw new Error("@runbun/astro: the highlighter nested its spans; lines can't be split");
        open = part;
      }
      html[html.length - 1] += part;
    }
  }
  // A token cut at a line's end leaves an empty copy on the next line (`// x\n\n` is one span).
  return { start, stop, html: html.map((line) => line.replace(/<span style="[^"]*"><\/span>/g, "")) };
}

/** Comment syntaxes a note marker can be written in, by language: `#` only where it starts a comment (not in TS's `#private`). */
const SLASH = ["//", "/*"];
const NOTE_COMMENTS: Record<string, string[]> = {};
for (const [syntaxes, langs] of [
  [SLASH, "ts tsx js jsx mjs cjs mts cts typescript javascript jsonc json5 c cpp cs csharp java kotlin go rust rs swift dart scala zig groovy php scss less sass"],
  [["/*"], "css"],
  [["#"], "py python rb ruby yaml yml toml sh bash zsh shell dockerfile docker graphql gql r perl makefile make env ini nix elixir ex exs"],
  [["<!--"], "html xml svg md markdown mdx"],
  [[...SLASH, "<!--"], "astro vue svelte"],
] as [string[], string][]) {
  for (const lang of langs.split(" ")) NOTE_COMMENTS[lang] = syntaxes;
}
const NOTE_SYNTAX: Record<string, string> = {
  "//": String.raw`//\s*\((\d+)\)`,
  "/*": String.raw`/\*\s*\((\d+)\)\s*\*/`,
  "#": String.raw`#\s*\((\d+)\)`,
  "<!--": String.raw`<!--\s*\((\d+)\)\s*-->`,
};
/** A line's last token when it is a comment (any `--hls-comment*` color), and its text. */
const LAST_COMMENT = /<span style="color:var\(--hls-comment[\w-]*\)">([^<]*)<\/span>$/;
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * Note markers: a line's trailing comment that is exactly `(N)` (`// (1)`, `/* (1) *\/`, `# (1)`, `<!-- (1) -->`, in the
 * syntaxes the language has), which highlights also colors as a comment, so one in a string or a template literal isn't.
 * `code` comes back without them (or the whitespace before them, so a copy has no trailing spaces), with each marked
 * line's index and N; the lines stay where they were.
 */
export function noteMarkers(code: string, lang: string): { code: string; notes: Map<number, number> } {
  const notes = new Map<number, number>();
  const syntaxes = NOTE_COMMENTS[lang];
  if (!syntaxes) return { code, notes };
  const re = new RegExp(`[ \\t]*(?:${syntaxes.map((s) => NOTE_SYNTAX[s]).join("|")})\\s*$`);
  const lines = code.split("\n");
  let html: string[] | undefined;
  for (const [i, line] of lines.entries()) {
    const m = re.exec(line);
    if (!m) continue;
    // Highlighted as codeBlock() does, so the line indexes agree.
    html ??= htmlLines(highlight(code.replace(/\n$/, ""), lang)).html;
    const last = LAST_COMMENT.exec(html[i] ?? "");
    if (!last || !unesc(last[1]!).trimEnd().endsWith(m[0].trim())) continue;
    notes.set(i, Number(m.slice(1).find(Boolean)));
    lines[i] = line.slice(0, m.index);
  }
  return { code: lines.join("\n"), notes };
}

/** Whether `notes` (noteMarkers') are exactly 1..count, each with an item to show, and no item without a marker. */
export const notesMatch = (notes: Map<number, number>, count: number) =>
  notes.size > 0 && [...notes.values()].every((n) => n >= 1 && n <= count) && new Set(notes.values()).size === count;

/** A note's marker, at the end of its line: empty, its number from CSS (`::before`), so a copy doesn't get it. */
export const noteButton = (id: string, n: number) =>
  `<button type="button" class="runbun-note" popovertarget="${esc(id)}" aria-label="Note ${n}" data-n="${n}"></button>`;

/** <Code notes>' list: plain-text items, each a popover its marker opens (the stylesheet shows them as bubbles). */
export const notesList = (ids: string[], notes: string[]) =>
  `<ol class="runbun-notes">${notes.map((note, i) => `<li id="${esc(ids[i]!)}" popover="auto">${esc(note)}</li>`).join("")}</ol>`;

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

/**
 * Several files as one block with a tab per file. Plain HTML: the tabs are radio buttons, and the stylesheet shows the
 * file whose tab is checked, so switching needs no script. `group` is the radios' name, unique on the page: the caller
 * makes it, from what stays the same between builds (the fence plugin: the page's path and the block's place; <Code>:
 * a count in Astro.locals), since Astro's content store keeps a rendered page across builds while a module counter
 * starts over, and two groups sharing a name would uncheck each other's tabs. `selected` names the tab checked first
 * (default: the first). One file is a plain block. A file's `lines` marks its lines (codeBlock).
 */
export function codeTabs(files: { name: string; code: string; lang?: string; lines?: BlockLines }[], group: string, selected?: string): string {
  if (files.length === 1) return codeBlock(files[0]!.code, files[0]!.lang ?? langOf(files[0]!.name), files[0]!.name, files[0]!.lines);
  const checked = Math.max(0, files.findIndex((f) => f.name === selected));
  const tabs = files
    .map((f, i) => `<label><input type="radio" name="${group}"${i === checked ? " checked" : ""}>${esc(f.name)}</label>`)
    .join("");
  const panels = files.map((f) => codeBlock(f.code, f.lang ?? langOf(f.name), undefined, f.lines)).join("");
  return `<div class="runbun-tabs not-content"><div class="runbun-tablist" aria-label="Files">${tabs}</div>${panels}</div>`;
}

/** A preset request (`requests`), with the response its author wrote after ` => ` (undefined without one). */
export interface PresetRequest {
  method: string;
  path: string;
  body: string;
  response: string | undefined;
  /** The headers given with `-H "Name: value"` before the body, when there are any. */
  headers?: [string, string][];
}

/**
 * `requests` (`GET / => Hello; POST /form {"a":1} => {"a":1}`) as the embed's attribute and the poster's entries. The
 * entries split as the playground splits them (apps/playground/src/embed/requests.ts, copied: the app isn't a
 * dependency): at a `;` followed by (optional whitespace,) an uppercase method, whitespace and `/`; headers, each `-H`
 * and a quoted `Name: value`, come before the body and stay in `attr` (one without a `:` is dropped from the poster,
 * as the playground skips it). In an entry, the
 * first ` => ` after the path (`=>` with whitespace or the entry's end around it) starts the author's response; a
 * response can't hold a `;` that a request would start after, since the split comes first, and a body can't hold
 * ` => ` (`x=>y` is fine). `attr` is the requests without their responses, joined with `; `, for the live embed, which
 * never sees a response; it is `list` as written when no entry has one. Entries the playground would skip (not
 * `METHOD /path`) stay in `attr` and out of `entries`.
 */
export function presetRequests(list: string): { attr: string; entries: PresetRequest[]; responses: boolean } {
  const parts = list.split(/;(?=\s*[A-Z]+\s+\/)/).map((p) => p.trim()).filter(Boolean);
  const entries: PresetRequest[] = [];
  const requests: string[] = [];
  for (const part of parts) {
    const m = /^([A-Z]+)\s+(\/\S*)(?:\s+([\s\S]*))?$/.exec(part);
    const rest = m?.[3] ?? "";
    const arrow = /(?:^|\s)=>(?:\s|$)/.exec(rest);
    const request = (arrow ? rest.slice(0, arrow.index) : rest).trim();
    const response = arrow ? rest.slice(arrow.index + arrow[0].length).trim() : undefined;
    requests.push(m && arrow ? `${m[1]} ${m[2]}${request ? " " + request : ""}` : part);
    let body = request;
    const headers: [string, string][] = [];
    for (let h; (h = /^-H\s+(?:"([^"]*)"|'([^']*)')\s*/.exec(body)); body = body.slice(h[0].length)) {
      const line = h[1] ?? h[2]!;
      const colon = line.indexOf(":");
      if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    if (m) entries.push({ method: m[1]!, path: m[2]!, body, response, ...(headers.length ? { headers } : {}) });
  }
  const responses = entries.some((e) => e.response !== undefined);
  return { attr: responses ? requests.join("; ") : list, entries, responses };
}

/** `text` highlighted as JSON when it parses as JSON, else as plain text. */
const jsonOrPlain = (text: string) => {
  let lang = "plain";
  try {
    JSON.parse(text);
    lang = "json";
  } catch {}
  return highlight(text, lang).replace(/^<pre /, `<pre data-language="${lang}" `);
};

/**
 * Preset requests and their written responses under a poster's code: a tab per request (`METHOD /path`, the method
 * only when it isn't GET, as the playground shows it), and per tab the request's headers and body, if any, and the response (then
 * labelled "Response"), or a note that running the code shows it. Plain HTML like codeTabs: radio tabs named `group`
 * (unique on the page, the same between builds), the stylesheet showing the checked one's panel, the first checked. It
 * sits in the poster, whose clicks don't start the embed (only its Run button does).
 */
export function requestPanel(entries: PresetRequest[], group: string): string {
  const tabs = entries
    .map(({ method, path }, i) => {
      const badge = method === "GET" ? "" : `<span class="runbun-method" data-method="${esc(method)}">${esc(method)}</span>`;
      return `<label><input type="radio" name="${esc(group)}"${i === 0 ? " checked" : ""}>${badge}<span class="runbun-path">${esc(path)}</span></label>`;
    })
    .join("");
  const panels = entries
    .map(({ body, response, headers }) => {
      const head = headers
        ? `<div class="runbun-request-headers"><div class="runbun-request-label">Request headers</div>${highlight(headers.map(([k, v]) => `${k}: ${v}`).join("\n"), "plain")}</div>`
        : "";
      const sent = head + (body ? `<div class="runbun-request-body"><div class="runbun-request-label">Request body</div>${jsonOrPlain(body)}</div>` : "");
      const got = response === undefined ? `<p class="runbun-response-pending">Run to see the response</p>` : jsonOrPlain(response);
      // Under a request body or headers, "Response" tells them apart; alone, the response needs no label.
      const label = sent ? `<div class="runbun-request-label">Response</div>` : "";
      return `<div class="runbun-request">${sent}<div class="runbun-response">${label}${got}</div></div>`;
    })
    .join("");
  return `<div class="runbun-requests not-content"><div class="runbun-requests-tablist" aria-label="Requests">${tabs}</div>${panels}</div>`;
}

/** A highlights language for a file name: its extension. */
export const langOf = (name: string) => name.slice(name.lastIndexOf(".") + 1) || "plain";

/** `features` with the embed's tab bar on, unless the author's list already says either way. */
export const withTabs = (features?: string): string => (/(^|,)\s*-?tabs\s*(,|$)/.test(features ?? "") ? (features as string) : [features, "tabs"].filter(Boolean).join(","));

/**
 * A file as an inline source of a <bun-playground>: `<\/script` and `<\!--` are how it is written inside a script.
 * `hidden` (a file the package generated) keeps it out of the embed's tabs; `generated` (the page's own, such as a
 * check a test runs) out of its tree and tabs too, and out of what `persist` saves.
 */
export function fileScript(path: string, text: string, hidden = false, generated = false) {
  const body = text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  return `<script type="text/plain" data-file="${esc(path)}"${hidden ? " data-hidden" : ""}${generated ? " data-generated" : ""}>\n${body}\n</script>`;
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
