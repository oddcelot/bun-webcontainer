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
// With `fences: "all"`, every other fence becomes a static block, as a static <Code> is (see parseStatic), and `// (1)`
// comments in it with an ordered list right after it become notes (see annotate).
// Options default to the runbun() integration's (playgroundUrl, base, sync, fences).
import type { Code, Root, RootContent } from "mdast";
import { CONFIG, type ResolvedConfig } from "./config.js";
import {
  type BlockLines,
  codeBlock,
  codeTabs,
  copyScript,
  cssLink,
  embedScripts,
  EXT,
  fileScript,
  lineNumbers,
  noteButton,
  noteMarkers,
  notesMatch,
  withEntry,
  withTabs,
} from "./markup.js";

const OWN_KEYS = new Set(["playground", "mode", "features", "group", "load", "height", "autorun", "readonly", "persist", "theme", "file", "path", "expand", "deps", "label", "layout"]);
const ATTRS = ["mode", "features", "height", "autorun", "readonly", "persist", "theme", "file", "path", "layout"];

/** Splits `a b=c title="d e"` into [key, value|null] tokens; `raw` is the token as written (`{1,4-6}`, `ins={2}`). */
interface Token {
  key: string | undefined;
  value: string | null;
  raw: string;
}

function tokens(meta: string): Token[] {
  const out: Token[] = [];
  const re = /(?:([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(meta))) out.push({ key: m[1], value: m[2] ?? m[3] ?? m[4] ?? null, raw: m[0] });
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
 * frontmatter, a `---`/`+++` pair left empty by it goes too. `kept` names each remaining line's index in `code`.
 */
function fileName(code: string, lang: string): { code: string; title?: string; kept?: number[] } {
  const lines = code.split(/\r?\n/);
  const kept = lines.map((_, i) => i);
  const drop = (at: number, n: number) => (lines.splice(at, n), kept.splice(at, n));
  const names = lines.slice(0, 4).map((line) => nameFromComment(line, lang));
  let i = names.findIndex(Boolean);
  const title = names[i];
  if (!title) return { code };
  drop(i, 1);
  if (FRONTMATTER.includes(lang)) {
    const open = i > 0 ? lines[i - 1]?.trim() : undefined;
    if (open === lines[i]?.trim() && (open === "---" || open === "+++")) drop(--i, 2);
  }
  if (lines[i]?.trim() === "") drop(i, 1);
  return { code: lines.join("\n"), title, kept };
}

type MarkKind = "mark" | "ins" | "del";
const MARK_KINDS: readonly string[] = ["mark", "ins", "del"];
/**
 * A line-mark token, `{1,4-6}` (a `mark`), `mark={…}`, `ins={…}` or `del={…}`, as its kind and 1-based lines; null
 * for anything else. Ranges only: Expressive Code's text and regex marks (`ins="x"`, `mark=/re/`), and a range with a
 * space in it (`{1, 4-6}`, two tokens), stay with it.
 */
function lineMark(t: Token): [MarkKind, number[]] | null {
  const kind = t.key ?? "mark";
  if (!MARK_KINDS.includes(kind)) return null;
  const list = (t.key === undefined ? t.raw : t.raw.slice(kind.length + 1)).match(/^\{(.*)\}$/)?.[1];
  const lines = list === undefined ? null : lineNumbers(list);
  return lines && [kind as MarkKind, lines];
}

/**
 * A fence that isn't a playground's as a static block (`fences: "all"`), or null to leave it to the site's highlighter.
 * Apart from parse() on purpose: transform()'s group loop relies on parse() being null for every other fence, so a
 * static fence never joins a playground group.
 */
function parseStatic(node: Code): { code: string; lang: string; title?: string | undefined; lines: BlockLines; group?: string | undefined } | null {
  const toks = tokens(node.meta ?? "");
  // `runbun=false` is the documented opt-out. The next check would keep the fence too (it isn't `title`), but the
  // promise doesn't rest on that.
  if (toks.some((t) => t.key === "runbun" && t.value === "false")) return null;
  // `title=…`, `group=…` and line marks only: any other word (`frame=`, `collapse=`, `showLineNumbers`, `wrap`,
  // `ins="text"`, …) asks for a feature of the site's highlighter that a static block hasn't.
  const marks: Partial<Record<MarkKind, number[]>> = {};
  for (const t of toks) {
    if ((t.key === "title" || t.key === "group") && t.value !== null) continue;
    const mark = lineMark(t);
    if (!mark) return null;
    (marks[mark[0]] ??= []).push(...mark[1]);
  }
  const lang = node.lang || "plain";
  // Expressive Code draws these as a terminal window, which a static block isn't.
  if (TERMINAL.has(lang)) return null;
  const title = toks.find((t) => t.key === "title")?.value;
  // No `title`: a file-name comment names the block, as in Expressive Code.
  const { code, title: named, kept } = title == null ? fileName(node.value, lang) : { code: node.value, title };
  // Marks count the fence's lines as written, the file-name comment's included (Expressive Code places them before
  // plugin-frames removes it), so they move with their lines, and one on a removed line goes. Lines past the end don't
  // exist to mark.
  const at = kept && new Map(kept.map((old, i) => [old, i]));
  const lines: BlockLines = {};
  for (const [kind, ns] of Object.entries(marks) as [MarkKind, number[]][]) {
    lines[kind] = ns.map((n) => (at ? at.get(n - 1) : n - 1)).filter((i): i is number => i !== undefined && i >= 0);
  }
  return { code, lang, title: named, lines, group: toks.find((t) => t.key === "group")?.value || undefined };
}
type Static = NonNullable<ReturnType<typeof parseStatic>>;

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

function embed(entries: [Entry, ...Entry[]], page: Page): RootContent {
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
  // A name only for real tabs: one file is a plain block.
  const group = shown.length > 1 ? tabsName(page) : "";
  const poster = shown.length > 1 || lead ? codeTabs(shown, group, opened) : codeTabs([{ ...shown[0]!, name: "" }], group);
  return html(
    `<bun-playground class="not-content" load="${esc(opts.load || "click")}"${expand}${attrs}>\n${files.join("\n")}\n` +
      `<div slot="poster">${poster}</div>\n</bun-playground>`,
  );
}

/**
 * A page as transform() goes through it: `all` (fences: "all"), its path and the path's hash (notes' ids), how many
 * static blocks it has had, and what it turned out to have: embeds need embed.js; blocks, static or a poster, need
 * the CSS and Copy script.
 */
interface Page {
  all: boolean;
  path: string;
  hash: string;
  statics: number;
  /** codeTabs() calls so far, for each tabbed block's radio name. */
  tabs: number;
  /** Whether the page has warned about notes in a group (once is enough). */
  warned: boolean;
  embeds: boolean;
  blocks: boolean;
}

/** A tabbed block's radio name: the page's path hash and the block's place, the same build after build (codeTabs). */
const tabsName = (page: Page) => `runbun-tabs-${page.hash}-${page.tabs++}`;

/**
 * Consecutive static fences with one `group` as one block with a tab per fence, the static counterpart of a playground
 * group. A tab is named by its fence's title, else its file-name comment, else `index.<ext>`, deduped as embed() does,
 * and keeps its fence's marks; the first is checked. A group of one is the block it would be ungrouped. Notes don't
 * group (their list after a fence would end the run), so grouped fences' markers stay comments, with one warning.
 */
function staticTabs(members: [Static, ...Static[]], page: Page): RootContent {
  if (!page.warned && members.some((m) => noteMarkers(m.code, m.lang).notes.size)) {
    page.warned = true;
    console.warn(`[@runbun/astro] ${page.path || "a page"}: note markers (// (1)) in a group=… fence stay comments; notes don't work in groups.`);
  }
  if (members.length === 1) return html(codeBlock(members[0].code, members[0].lang, members[0].title, members[0].lines));
  const files: { name: string; code: string; lang: string; lines: BlockLines }[] = [];
  for (const { title, code, lang, lines } of members) {
    const ext = EXT[lang] ?? (lang === "plain" ? "txt" : lang);
    let name = title || `index.${ext}`;
    for (let n = 2; files.some((f) => f.name === name); n++) name = `index${n}.${ext}`;
    files.push({ name, code, lang, lines });
  }
  return html(codeTabs(files, tabsName(page)));
}

/** FNV-1a of `s`, base 36: a short, stable stand-in for a page's path in ids. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * A static block's note markers (`// (1)`, noteMarkers) paired with the ordered list right after its fence: each
 * marker becomes a button that opens its item, and the list stays in the page with its items as popovers
 * (`data.hProperties`, which mdast-util-to-hast keeps in Markdown and MDX). Ids hash the page's path with the block's
 * place and the note's number: the content store caches a rendered page across builds while a counter would start
 * over, so a counter's ids could collide. A fence whose markers and list don't pair up (no list, a short or long one)
 * keeps its markers as comments and the list as it is, with a warning.
 */
function annotate(block: Static, next: RootContent | undefined, page: Page): void {
  const { code, notes } = noteMarkers(block.code, block.lang);
  if (!notes.size) return;
  const list = next?.type === "list" && next.ordered && (next.start ?? 1) === 1 ? next : undefined;
  if (!list || !notesMatch(notes, list.children.length)) {
    console.warn(
      `[@runbun/astro] ${page.path || "a page"}: a code block has note markers (${[...notes.values()].map((n) => `(${n})`).join(", ")}) ` +
        "but no ordered list right after it with one item per marker; they stay comments.",
    );
    return;
  }
  const id = (n: number) => `runbun-note-${page.hash}-${page.statics}-${n}`;
  Object.assign((list.data ??= {}), { hProperties: { className: ["runbun-notes"] } });
  for (const [k, item] of list.children.entries()) Object.assign((item.data ??= {}), { hProperties: { id: id(k + 1), popover: "auto" } });
  block.code = code;
  block.lines.end = Object.fromEntries([...notes].map(([line, n]) => [line, noteButton(id(n), n)]));
}

function transform(children: RootContent[], page: Page): void {
  const out: RootContent[] = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    const first = node.type === "code" ? parse(node) : null;
    const block = !first && page.all && node.type === "code" ? parseStatic(node) : null;
    if (block) {
      page.blocks = true;
      if (block.group) {
        const members: [Static, ...Static[]] = [block];
        // The run ends at anything but a static fence of the same group: a playground fence (never a tab here, as a
        // static fence never joins a playground group), one that falls back, another node.
        while (children[i + 1]?.type === "code") {
          const next = children[i + 1] as Code;
          const member = parse(next) ? null : parseStatic(next);
          if (!member || member.group !== block.group) break;
          members.push(member);
          i++;
        }
        out.push(staticTabs(members, page));
      } else {
        annotate(block, children[i + 1], page);
        out.push(html(codeBlock(block.code, block.lang, block.title, block.lines)));
      }
      page.statics++;
      continue;
    }
    if (!first) {
      if ("children" in node) transform(node.children, page);
      out.push(node);
      continue;
    }
    page.embeds = true;
    const entries: [Entry, ...Entry[]] = [first];
    const group = first.opts.group;
    while (group && children[i + 1]?.type === "code") {
      const next = parse(children[i + 1] as Code);
      if (!next || next.opts.group !== group) break;
      entries.push(next);
      i++;
    }
    out.push(embed(entries, page));
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
    const path = file?.path ?? "";
    const page: Page = { all: fences === "all", path, hash: hash(path), statics: 0, tabs: 0, warned: false, embeds: false, blocks: false };
    transform(tree.children, page);
    if (!page.embeds && !page.blocks) return;
    // In MDX the blocks' CSS is an import, which Astro bundles into the page's stylesheet as it does for <Code> (one
    // copy for both); Markdown can't import, so it links the integration's route.
    if (mdx) tree.children.unshift(cssImport());
    // embed.js (and the sync script) only for a page with an embed: static blocks are HTML and CSS.
    tree.children.push(html((mdx ? "" : cssLink(base) + "\n") + (page.embeds ? embedScripts(playgroundUrl, sync) : "") + copyScript()));
  };
}
