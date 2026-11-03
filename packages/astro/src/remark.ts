// Turns ```ts playground … fences into runnable <bun-playground> embeds whose poster is the code, highlighted as a
// <Code> block is. Click-to-load: nothing downloads until a reader presses Run.
//
// Meta words: `playground` (required), `mode=…`, `features=…`, `group=<name>`, `load=…`, `height=…`, `path=…`,
// `deps="elysia@rc,zod@^4"` (pinned in a package.json the poster doesn't show; a package.json fence wins); `title="x.ts"`
// names the file. Consecutive fences with the same `group` share one embed (the first fence's options apply).
// Options default to the runbun() integration's (playgroundUrl, base, sync).
import type { Code, Root, RootContent } from "mdast";
import { CONFIG } from "./config.js";
import { codeTabs, cssLink, embedScripts, EXT, fileScript, withEntry, withTabs } from "./markup.js";

const OWN_KEYS = new Set(["playground", "mode", "features", "group", "load", "height", "autorun", "readonly", "persist", "theme", "file", "path", "expand", "deps"]);
const ATTRS = ["mode", "features", "height", "autorun", "readonly", "persist", "theme", "file", "path"];

/** Splits `a b=c title="d e"` into [key, value|null] tokens. */
interface Token {
  key: string | undefined;
  value: string | null;
}

function tokens(meta: string): Token[] {
  const out: Token[] = [];
  const re = /(?:([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(meta))) out.push({ key: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
  return out;
}

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/**
 * Raw HTML for the page. MDX turns a raw `<script>`'s text into a literal `set:html` attribute, so the embed's files
 * would arrive empty; there the HTML goes through Astro's `<Fragment set:html>` untouched.
 */
let mdx = false;
const html = (value: string): RootContent =>
  mdx
    ? ({ type: "mdxJsxFlowElement", name: "Fragment", attributes: [{ type: "mdxJsxAttribute", name: "set:html", value }], children: [] } as unknown as RootContent)
    : { type: "html", value };

/** `import "virtual:@runbun/astro/blocks.css"` as an MDX ESM node (its estree is what MDX compiles). */
const CSS_MODULE = "virtual:@runbun/astro/blocks.css";
const cssImport = (): RootContent =>
  ({
    type: "mdxjsEsm",
    value: `import ${JSON.stringify(CSS_MODULE)};`,
    data: {
      estree: {
        type: "Program",
        sourceType: "module",
        body: [{ type: "ImportDeclaration", specifiers: [], attributes: [], source: { type: "Literal", value: CSS_MODULE, raw: JSON.stringify(CSS_MODULE) } }],
      },
    },
  }) as unknown as RootContent;

interface Entry {
  opts: Record<string, string>;
  title: string | null | undefined;
  node: Code;
}

function parse(node: Code): Entry | null {
  const toks = tokens(node.meta ?? "");
  if (!toks.some((t) => t.key === "playground" && t.value === null)) return null;
  const opts: Record<string, string> = {};
  for (const t of toks) if (t.key && OWN_KEYS.has(t.key)) opts[t.key] = t.value ?? "";
  const title = toks.find((t) => t.key === "title")?.value;
  return { opts, title, node };
}

/** `elysia@rc, @elysia/openapi@rc, zod` → { elysia: "rc", "@elysia/openapi": "rc", zod: "latest" }; malformed entries are skipped. */
function parseDeps(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list.split(",")) {
    const s = item.trim();
    const at = s.lastIndexOf("@");
    const [name, range] = at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [s, "latest"];
    if (range && /^(@[\w.-]+\/)?[\w.-]+$/.test(name)) out[name] = range;
  }
  return out;
}

function embed(entries: [Entry, ...Entry[]]): RootContent {
  const { opts } = entries[0];
  const sources: Record<string, string> = {};
  const shown: { name: string; code: string; lang: string }[] = [];
  for (const { title, node } of entries) {
    const ext = EXT[node.lang ?? ""] ?? node.lang ?? "txt";
    let name = title || `index.${ext}`;
    for (let n = 2; name in sources; n++) name = `index${n}.${ext}`;
    sources[name] = node.value;
    shown.push({ name, code: node.value, lang: node.lang ?? "plain" });
  }
  // Several files show as tabs, before Run and after.
  if (shown.length > 1) opts.features = withTabs(opts.features);
  // The first fence is the one Run starts, unless the group has an index file of its own.
  const names = Object.keys(sources);
  const entry = names.find((n) => /^(src\/)?index\.[jt]sx?$/.test(n)) ?? names[0]!;
  const all = withEntry(sources, entry);
  // `deps` goes into the package.json withEntry may have made (its `main`), unless a fence is the package.json.
  const deps = "package.json" in sources ? {} : parseDeps(opts.deps ?? "");
  if (Object.keys(deps).length) {
    all["package.json"] = JSON.stringify({ ...JSON.parse(all["package.json"] ?? "{}"), dependencies: deps }, null, 2) + "\n";
  }
  const files = Object.entries(all).map(([name, text]) => fileScript(name, text));
  const attrs = ATTRS.filter((k) => k in opts).map((k) => ` ${k}="${esc(opts[k])}"`).join("");
  // A docs snippet opens as the whole playground in a modal unless the fence says otherwise (`expand=false`, `expand=on`).
  const expand = opts.expand === "false" ? "" : ` expand="${esc(opts.expand || "full")}"`;
  // The tab checked first is the file the embed opens with: `file`, else the one Run starts.
  const opened = opts.file && opts.file in sources ? opts.file : entry;
  const poster = shown.length > 1 || entries[0].title ? codeTabs(shown, opened) : codeTabs([{ ...shown[0]!, name: "" }]);
  return html(
    `<bun-playground class="not-content" load="${esc(opts.load || "click")}"${expand}${attrs}>\n${files.join("\n")}\n` +
      `<div slot="poster">${poster}</div>\n</bun-playground>`,
  );
}

function transform(children: RootContent[]): boolean {
  const out: RootContent[] = [];
  let found = false;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    const first = node.type === "code" ? parse(node) : null;
    if (!first) {
      if ("children" in node) found = transform(node.children) || found;
      out.push(node);
      continue;
    }
    found = true;
    const entries: [Entry, ...Entry[]] = [first];
    const group = first.opts.group;
    while (group && children[i + 1]?.type === "code") {
      const next = parse(children[i + 1] as Code);
      if (!next || next.opts.group !== group) break;
      entries.push(next);
      i++;
    }
    out.push(embed(entries));
  }
  children.splice(0, children.length, ...out);
  return found;
}

/** ```ts playground fences as embeds. Options default to the runbun() integration's. */
export default function remarkRunbun(
  options: { playgroundUrl?: string; base?: string; sync?: { scheme?: string; family?: string } } = {},
): (tree: Root, file?: { path?: string }) => void {
  return (tree, file) => {
    mdx = /\.mdx$/.test(file?.path ?? "");
    if (!transform(tree.children)) return;
    const { playgroundUrl, base, sync } = { ...CONFIG(), ...options };
    // In MDX the blocks' CSS is an import, which Astro bundles into the page's stylesheet as it does for <Code> (one
    // copy for both); Markdown can't import, so it links the integration's route.
    if (mdx) tree.children.unshift(cssImport());
    tree.children.push(html((mdx ? "" : cssLink(base) + "\n") + embedScripts(playgroundUrl, sync)));
  };
}
