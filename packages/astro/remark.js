// Turns ```ts playground … fences into runnable <bun-playground> embeds whose poster is the code, highlighted as a
// <Code> block is. Click-to-load: nothing downloads until a reader presses Run.
//
// Meta words: `playground` (required), `mode=…`, `features=…`, `group=<name>`, `load=…`, `height=…`; `title="x.ts"`
// names the file. Consecutive fences with the same `group` share one embed (the first fence's options apply).
// Options default to the runbun() integration's (playgroundUrl, base, sync).
import { CONFIG } from "./config.js";
import { codeBlock, cssLink, embedScripts, EXT, fileScript, withEntry } from "./markup.js";

const OWN_KEYS = new Set(["playground", "mode", "features", "group", "load", "height", "autorun", "readonly", "persist", "theme", "file", "expand"]);
const ATTRS = ["mode", "features", "height", "autorun", "readonly", "persist", "theme", "file"];

/** Splits `a b=c title="d e"` into [key, value|null] tokens. */
function tokens(meta) {
  const out = [];
  const re = /(?:([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?)|(\S+)/g;
  let m;
  while ((m = re.exec(meta))) out.push({ key: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
  return out;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/**
 * Raw HTML for the page. MDX turns a raw `<script>`'s text into a literal `set:html` attribute, so the embed's files
 * would arrive empty; there the HTML goes through Astro's `<Fragment set:html>` untouched.
 */
let mdx = false;
const html = (value) =>
  mdx
    ? { type: "mdxJsxFlowElement", name: "Fragment", attributes: [{ type: "mdxJsxAttribute", name: "set:html", value }], children: [] }
    : { type: "html", value };

function parse(node) {
  const toks = tokens(node.meta ?? "");
  if (!toks.some((t) => t.key === "playground" && t.value === null)) return null;
  const opts = {};
  for (const t of toks) if (t.key && OWN_KEYS.has(t.key)) opts[t.key] = t.value ?? "";
  const title = toks.find((t) => t.key === "title")?.value;
  return { opts, title, node };
}

function embed(entries) {
  const { opts } = entries[0];
  const sources = {};
  for (const { title, node } of entries) {
    const ext = EXT[node.lang ?? ""] ?? node.lang ?? "txt";
    let name = title || `index.${ext}`;
    for (let n = 2; name in sources; n++) name = `index${n}.${ext}`;
    sources[name] = node.value;
  }
  // The first fence is the one Run starts, unless the group has an index file of its own.
  const names = Object.keys(sources);
  const entry = names.find((n) => /^(src\/)?index\.[jt]sx?$/.test(n)) ?? names[0];
  const files = Object.entries(withEntry(sources, entry)).map(([name, text]) => fileScript(name, text));
  const attrs = ATTRS.filter((k) => k in opts).map((k) => ` ${k}="${esc(opts[k])}"`).join("");
  // A docs snippet opens as the whole playground in a modal unless the fence says otherwise (`expand=false`, `expand=on`).
  const expand = opts.expand === "false" ? "" : ` expand="${esc(opts.expand || "full")}"`;
  const poster = entries.map((e) => codeBlock(e.node.value, e.node.lang ?? "plain", e.title)).join("");
  return html(
    `<bun-playground class="not-content" load="${esc(opts.load || "click")}"${expand}${attrs}>\n${files.join("\n")}\n` +
      `<div slot="poster">${poster}</div>\n</bun-playground>`,
  );
}

function transform(children) {
  const out = [];
  let found = false;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const first = node.type === "code" ? parse(node) : null;
    if (!first) {
      if (node.children) found = transform(node.children) || found;
      out.push(node);
      continue;
    }
    found = true;
    const entries = [first];
    const group = first.opts.group;
    while (group && children[i + 1]?.type === "code") {
      const next = parse(children[i + 1]);
      if (!next || next.opts.group !== group) break;
      entries.push(next);
      i++;
    }
    out.push(embed(entries));
  }
  children.splice(0, children.length, ...out);
  return found;
}

/** @param {{ playgroundUrl?: string, base?: string, sync?: { scheme?: string, family?: string } }} [options] */
export default function remarkRunbun(options = {}) {
  return (tree, file) => {
    mdx = /\.mdx$/.test(file?.path ?? "");
    if (!transform(tree.children)) return;
    const { playgroundUrl, base, sync } = { ...CONFIG(), ...options };
    tree.children.push(html(cssLink(base) + "\n" + embedScripts(playgroundUrl, sync)));
  };
}
