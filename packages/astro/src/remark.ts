// Turns ```ts playground … fences into runnable <bun-playground> embeds whose poster is the code, highlighted as a
// <Code> block is. Click-to-load: nothing downloads until a reader presses Run.
//
// Meta words: `playground` (required), `mode=…`, `features=…`, `group=<name>`, `load=…`, `height=…`, `path=…`,
// `layout=stack` (the preview under the editor), `deps="elysia@rc,zod@^4"` (pinned in a package.json the poster doesn't
// show; a package.json fence wins), `label="…"` (the embed's accessible name, its `title` attribute; default "Bun
// playground"); `title="x.ts"` names the file.
// Consecutive fences with the same `group` share one embed (the first fence's options apply). In a group, `hidden`
// keeps a fence out of the poster and the tabs (`data-hidden`) while it stays a file of the embed: a package.json the
// author pins, say. It's never the file Run starts or the one opened; a group must show something, so `hidden` on its
// first fence is ignored when every fence has it (or the fence is alone).
// With `fences: "all"`, every other fence becomes a static block, as a static <Code> is (see parseStatic).
// Options default to the runbun() integration's (playgroundUrl, base, sync, fences).
import type { Code, Root, RootContent } from "mdast";
import { CONFIG, type ResolvedConfig } from "./config.js";
import { codeBlock, codeTabs, copyScript, cssLink, embedScripts, EXT, fileScript, withEntry, withTabs } from "./markup.js";

const OWN_KEYS = new Set(["playground", "mode", "features", "group", "load", "height", "autorun", "readonly", "persist", "theme", "file", "path", "expand", "deps", "label", "layout"]);
const ATTRS = ["mode", "features", "height", "autorun", "readonly", "persist", "theme", "file", "path", "layout"];

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
  /** `hidden`: a file of the embed, but not of the poster or the tabs. */
  hidden: boolean;
}

function parse(node: Code): Entry | null {
  const toks = tokens(node.meta ?? "");
  if (!toks.some((t) => t.key === "playground" && t.value === null)) return null;
  const opts: Record<string, string> = {};
  for (const t of toks) if (t.key && OWN_KEYS.has(t.key)) opts[t.key] = t.value ?? "";
  const title = toks.find((t) => t.key === "title")?.value;
  return { opts, title, node, hidden: toks.some((t) => t.key === "hidden" && t.value === null) };
}

// Expressive Code's language groups, as @expressive-code/plugin-frames 0.44 has them (`LanguageGroups`, src/utils.ts):
// `terminal` is the list it draws a terminal window for, and the file-name rule below reads every group.
const LANGUAGE_GROUPS = {
  code: ["astro", "cjs", "htm", "html", "js", "jsx", "mjs", "svelte", "ts", "tsx", "typescript", "vb", "vue", "vue-html"],
  terminal: ["ansi", "bash", "bat", "batch", "cmd", "console", "fish", "nu", "nushell", "powershell", "ps", "ps1", "psd1", "psm1", "sh", "shell", "shellscript", "shellsession", "zsh"],
  data: ["csv", "env", "ini", "json", "toml", "xml", "yaml", "yml"],
  styles: ["css", "less", "sass", "scss", "styl", "stylus", "xsl"],
  textContent: ["markdown", "md", "mdx"],
};
const TERMINAL = new Set(LANGUAGE_GROUPS.terminal);
/** Languages whose file-name comment can sit in frontmatter (plugin-frames' `LanguagesWithFencedFrontmatter`). */
const FRONTMATTER = ["astro", "markdown", "md", "mdx", "toml", "yaml", "yml"];
/**
 * plugin-frames' file-name comment (`getFileNameCommentRegExpString`): a whole line that is `//`, `#` (not `#!`), `<!--`
 * or `/*`, an optional `Prefix:` (not a drive letter's `C:` or a URL's `https:`), then the name (path characters and an
 * optional known extension), and an optional `-->` or `*\/`.
 */
const FILE_NAME_COMMENT = new RegExp(
  String.raw`^\s*(?://|#(?!!)|<!--|/\*)\s*(?:((?![a-z]:).*?)(?:：|:(?!//)))?\s*((?:[a-z]:)?[\w./~%[\]+\\-]*` +
    String.raw`(?:\.(?:${Object.values(LANGUAGE_GROUPS).flat().sort().join("|")}))?)\s*(?:-->|\*/)?\s*$`,
  "i",
);

/**
 * The file name a comment line gives, by plugin-frames' `getFileNameFromComment`: not after `@filename`, not only dots
 * and separators, not `..x`. A name that looks like a path (`/x`, `./x`, `~x`, `C:x`, `.env`, `src/app/x`) counts when
 * nothing precedes it (or the language is a shell's); anything else needs an extension, from the language's own group
 * when it has one (`// config.json` names a JSON block, not a TypeScript one).
 */
function nameFromComment(line: string, lang: string): string | undefined {
  const [, before = "", name] = FILE_NAME_COMMENT.exec(line) ?? [];
  if (!name || before.trim().toLowerCase() === "@filename") return;
  if (!/[^.:/\\~]/.test(name) || /^\.{2,}(?!\/|\\)/.test(name)) return;
  const group = Object.values(LANGUAGE_GROUPS).find((g) => g.includes(lang));
  const base = name.replace(/^.*[/\\]/, "");
  const ext = base.match(/\.([^.]+)$/)?.[1];
  const separated = /[/\\]/.test(name) && /[^/\\0-9.]/.test(name) && !/\s/.test(name) && name === name.toLowerCase();
  const pathLike = /^(\/|\\|\.[/\\]|~|[a-z]:).+/i.test(name) || base.startsWith(".") || separated;
  if (pathLike && (!before.length || group === LANGUAGE_GROUPS.terminal)) return name;
  if (!ext || (group && !group.includes(ext))) return;
  return name;
}

/**
 * `code`'s title from a file-name comment, as plugin-frames' `extractFileNameFromCodeBlock` finds it: the first of
 * the first four lines that is one. That line goes, and so does an empty line right after it; in a language with
 * frontmatter, a `---`/`+++` pair left empty by it goes too.
 */
function fileName(code: string, lang: string): { code: string; title?: string } {
  const lines = code.split(/\r?\n/);
  const names = lines.slice(0, 4).map((line) => nameFromComment(line, lang));
  let i = names.findIndex(Boolean);
  const title = names[i];
  if (!title) return { code };
  lines.splice(i, 1);
  if (FRONTMATTER.includes(lang)) {
    const open = i > 0 ? lines[i - 1]?.trim() : undefined;
    if (open === lines[i]?.trim() && (open === "---" || open === "+++")) lines.splice(--i, 2);
  }
  if (lines[i]?.trim() === "") lines.splice(i, 1);
  return { code: lines.join("\n"), title };
}

/**
 * A fence that isn't a playground's as a static block (`fences: "all"`), or null to leave it to the site's highlighter.
 * Apart from parse() on purpose: transform()'s group loop relies on parse() being null for every other fence, so a
 * static fence never joins a playground group.
 */
function parseStatic(node: Code): { code: string; lang: string; title?: string | undefined } | null {
  const toks = tokens(node.meta ?? "");
  // `runbun=false` is the documented opt-out. The next check would keep the fence too (it isn't `title`), but the
  // promise doesn't rest on that.
  if (toks.some((t) => t.key === "runbun" && t.value === "false")) return null;
  // `title=…` only: any other word (`ins=`, `{5-8}`, `mark=`, `frame=`, `showLineNumbers`, `wrap`, …) asks for a
  // feature of the site's highlighter that a static block hasn't.
  if (!toks.every((t) => t.key === "title" && t.value !== null)) return null;
  const lang = node.lang || "plain";
  // Expressive Code draws these as a terminal window, which a static block isn't.
  if (TERMINAL.has(lang)) return null;
  const title = toks.find((t) => t.key === "title")?.value;
  // No `title`: a file-name comment names the block, as in Expressive Code.
  return title == null ? { lang, ...fileName(node.value, lang) } : { code: node.value, lang, title };
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
  const hidden = new Set<string>();
  // The first fence shown: a lone block shows its title, or none.
  let lead: string | null | undefined;
  // Something has to show: with every fence hidden, the first one isn't.
  const allHidden = entries.every((e) => e.hidden);
  for (const [i, { title, node, hidden: hide }] of entries.entries()) {
    const ext = EXT[node.lang ?? ""] ?? node.lang ?? "txt";
    let name = title || `index.${ext}`;
    for (let n = 2; name in sources; n++) name = `index${n}.${ext}`;
    sources[name] = node.value;
    if (hide && !(allHidden && i === 0)) hidden.add(name);
    else {
      if (!shown.length) lead = title;
      shown.push({ name, code: node.value, lang: node.lang ?? "plain" });
    }
  }
  // Several files show as tabs, before Run and after.
  if (shown.length > 1) opts.features = withTabs(opts.features);
  // The first fence shown is the one Run starts, unless the group shows an index file of its own.
  const names = shown.map((f) => f.name);
  const entry = names.find((n) => /^(src\/)?index\.[jt]sx?$/.test(n)) ?? names[0]!;
  // A hidden file isn't opened first either.
  if (opts.file && hidden.has(opts.file)) delete opts.file;
  // A copy: withEntry hands `sources` back as is when it adds nothing, and `deps` may add the package.json below.
  const all = { ...withEntry(sources, entry) };
  // `deps` goes into the package.json withEntry may have made (its `main`), unless a fence is the package.json.
  const deps = "package.json" in sources ? {} : parseDeps(opts.deps ?? "");
  if (Object.keys(deps).length) {
    all["package.json"] = JSON.stringify({ ...JSON.parse(all["package.json"] ?? "{}"), dependencies: deps }, null, 2) + "\n";
  }
  // The package.json made here (`main`, `deps`) runs but stays out of the tabs, as do `hidden` fences; another fence
  // is a tab.
  const files = Object.entries(all).map(([name, text]) => fileScript(name, text, !(name in sources) || hidden.has(name)));
  // `title` names a fence's file, so the embed's own title (its accessible name) comes from `label`.
  const attrs = ATTRS.filter((k) => k in opts).map((k) => ` ${k}="${esc(opts[k])}"`).join("") + ("label" in opts ? ` title="${esc(opts.label)}"` : "");
  // A docs snippet opens as the whole playground in a modal unless the fence says otherwise (`expand=false`, `expand=on`).
  const expand = opts.expand === "false" ? "" : ` expand="${esc(opts.expand || "full")}"`;
  // The tab checked first is the file the embed opens with: `file`, else the one Run starts.
  const opened = opts.file && opts.file in sources ? opts.file : entry;
  const poster = shown.length > 1 || lead ? codeTabs(shown, opened) : codeTabs([{ ...shown[0]!, name: "" }]);
  return html(
    `<bun-playground class="not-content" load="${esc(opts.load || "click")}"${expand}${attrs}>\n${files.join("\n")}\n` +
      `<div slot="poster">${poster}</div>\n</bun-playground>`,
  );
}

/** What a page turned out to have: embeds need embed.js; blocks, static or a poster, need the CSS and Copy script. */
interface Found {
  embeds: boolean;
  blocks: boolean;
}

function transform(children: RootContent[], all: boolean, found: Found): void {
  const out: RootContent[] = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    const first = node.type === "code" ? parse(node) : null;
    const block = !first && all && node.type === "code" ? parseStatic(node) : null;
    if (block) {
      found.blocks = true;
      out.push(html(codeBlock(block.code, block.lang, block.title)));
      continue;
    }
    if (!first) {
      if ("children" in node) transform(node.children, all, found);
      out.push(node);
      continue;
    }
    found.embeds = true;
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
}

/**
 * ```ts playground fences as embeds, and with `fences: "all"` the others as static blocks. Options default to the
 * runbun() integration's.
 */
export default function remarkRunbun(
  options: { playgroundUrl?: string; base?: string; sync?: { scheme?: string; family?: string }; fences?: ResolvedConfig["fences"] } = {},
): (tree: Root, file?: { path?: string }) => void {
  return (tree, file) => {
    mdx = /\.mdx$/.test(file?.path ?? "");
    // Read before transforming, which needs `fences`; the config is the same whenever it's read.
    const { playgroundUrl, base, sync, fences } = { ...CONFIG(), ...options };
    const found: Found = { embeds: false, blocks: false };
    transform(tree.children, fences === "all", found);
    if (!found.embeds && !found.blocks) return;
    // In MDX the blocks' CSS is an import, which Astro bundles into the page's stylesheet as it does for <Code> (one
    // copy for both); Markdown can't import, so it links the integration's route.
    if (mdx) tree.children.unshift(cssImport());
    // embed.js (and the sync script) only for a page with an embed: static blocks are HTML and CSS.
    tree.children.push(html((mdx ? "" : cssLink(base) + "\n") + (found.embeds ? embedScripts(playgroundUrl, sync) : "") + copyScript()));
  };
}
