// The fence plugin on hand-built mdast trees (the shape remark-parse gives a fence: `lang` is its first word, `meta` the
// rest). remark.test.json is what the plugin produced before `fences` existed (main at 7afcb68), for the default mode
// to be checked against byte for byte.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Code, List, Root, RootContent } from "mdast";
import { setConfig } from "./config.js";
import { highlight } from "./highlight.js";
import { codeBlock, propLines } from "./markup.js";
import remarkRunbun from "./remark.js";
import before from "./remark.test.json";

const code = (lang: string | null, meta: string | null, value: string): Code => ({ type: "code", lang, meta, value });

/** Runs the plugin on `children` as a page at `path`; the tab-group counter restarts so radio names are stable. */
function run(children: RootContent[], options: Parameters<typeof remarkRunbun>[0] = {}, path = "page.md"): RootContent[] {
  (globalThis as { [k: symbol]: { n: number } })[Symbol.for("runbun.tabGroups")] = { n: 0 };
  const tree: Root = { type: "root", children };
  remarkRunbun(options)(tree, { path });
  return tree.children;
}

/** The raw HTML of a node the plugin made: an `html` node in Markdown, a `<Fragment set:html>` in MDX. */
const htmlOf = (node: RootContent | undefined): string | undefined => {
  if (node?.type === "html") return node.value;
  const attrs = (node as { attributes?: { name: string; value: string }[] } | undefined)?.attributes;
  return attrs?.find((a) => a.name === "set:html")?.value;
};

/** Every fence kind a default-mode page had before `fences`: plain, titled, lone, grouped, nested, shell. */
const mixed = (): RootContent[] => [
  { type: "paragraph", children: [{ type: "text", value: "Intro" }] },
  code("ts", null, "const a = 1;"),
  code("ts", 'title="x.ts"', "// y.ts\nconst b = 2;"),
  code("ts", 'playground title="index.ts"', "console.log(1);"),
  code("ts", 'playground group=g title="index.ts"', 'import { a } from "./a";'),
  code("ts", 'playground group=g title="a.ts"', "export const a = 1;"),
  code(null, null, "plain text"),
  { type: "blockquote", children: [code("ts", "playground", "1")] },
  code("sh", null, "bun add x"),
];
const plain = (): RootContent[] => [code("ts", null, "const a = 1;"), code(null, null, "// server.ts\nx")];

afterEach(() => setConfig({}));

/** The code element's text as Copy reads it (textContent): tags out, entities decoded. */
const text = (html: string) =>
  html.match(/<code[^>]*>([\s\S]*)<\/code>/)![1]!.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Each `<span class="line">`'s data attributes, in order: `["ins", "", "mark del"]`. */
const marksOf = (html: string) => [...html.matchAll(/<span class="line"([^>]*)>/g)].map((m) => m[1]!.replace(/ data-/g, " ").trim());

/** Sources whose tokens span lines: a template literal, block and line comments over blank lines, HTML's bare text. */
const SAMPLES: [string, string][] = [
  ["const a = `x\n  y`;\n/* a\n b */\nlet b = 1; // c\n\n\nclass A { #p = 1 }", "ts"],
  ["<!-- c -->\n<p>hi &amp; <b>bye</b></p>\n", "html"],
  ["a: 1 # c\n# d\nb: 'x # y'\nc: |\n  multi\n  line", "yaml"],
  ['{\n  "a": [1, 2],\n  "b": "c"\n}', "json"],
  ["x  \n\ty < z && w > v", "plain"],
  ['def f():\n    """doc\n    string"""\n    return 1 # c', "py"],
  [".a {\n  color: red; /* c */\n}", "css"],
  ["# T\n\n- a\n- `b`\n\n```js\nx\n```", "md"],
];

describe("default mode", () => {
  for (const [name, make] of [["mixed", mixed], ["plain", plain]] as const)
    for (const path of ["page.md", "page.mdx"])
      test(`${name} ${path}: output is byte-identical to before fences existed, so upgrading changes no page`, () => {
        expect(JSON.stringify(run(make(), {}, path))).toBe((before as Record<string, string>)[`${name} ${path}`]!);
      });
});

describe('fences: "all"', () => {
  const all = { fences: "all" } as const;
  const one = (node: Code, path = "page.md") => run([node], all, path)[0];

  test("a plain fence becomes the same HTML as a static <Code>, so fences and components look alike", () => {
    expect(htmlOf(one(code("ts", null, "const a = 1;")))).toBe(codeBlock("const a = 1;", "ts"));
  });

  test("a fence without a language is highlighted as plain, as <Code> does for unknown languages", () => {
    expect(htmlOf(one(code(null, null, "hello")))).toBe(codeBlock("hello", "plain"));
  });

  test("title=… in any quoting is the only meta a static block understands, so it becomes the caption", () => {
    for (const meta of ['title="a b.ts"', "title='a b.ts'"]) expect(htmlOf(one(code("ts", meta, "x")))).toBe(codeBlock("x", "ts", "a b.ts"));
    expect(htmlOf(one(code("ts", "title=x.ts", "x")))).toBe(codeBlock("x", "ts", "x.ts"));
  });

  test("meta the site's highlighter understands but a static block can't render leaves the fence to it", () => {
    for (const meta of ['ins="x"', "mark=/re/", "{1, 4-6}", "{a}", "mark=3", "add={1}", "error-preview", "showLineNumbers", "frame=none", "collapse={1-2}", "wrap", 'title="x.ts" del="y"', "stray"]) {
      expect(one(code("ts", meta, "x"))).toEqual(code("ts", meta, "x"));
    }
  });

  test("runbun=false opts a fence out even when the rest of its meta is only a title", () => {
    for (const meta of ["runbun=false", 'title="x.ts" runbun=false', 'runbun="false"']) expect(one(code("ts", meta, "x"))).toEqual(code("ts", meta, "x"));
  });

  test("shell languages stay for Expressive Code's terminal frame, which a static block doesn't draw", () => {
    for (const lang of ["bash", "sh", "shell", "zsh", "powershell", "ps1", "console", "fish"]) expect(one(code(lang, null, "bun add x"))).toEqual(code(lang, null, "bun add x"));
  });

  test("a file-name comment on the first line names the block and leaves the code, as Expressive Code does", () => {
    expect(htmlOf(one(code("ts", null, "// server.ts\n\nBun.serve({});")))).toBe(codeBlock("Bun.serve({});", "ts", "server.ts"));
    expect(htmlOf(one(code("ts", null, '"use strict";\n// src/index.ts\nx')))).toBe(codeBlock('"use strict";\nx', "ts", "src/index.ts"));
  });

  test("an explicit title wins over a file-name comment, which then stays code", () => {
    expect(htmlOf(one(code("ts", 'title="a.ts"', "// b.ts\nx")))).toBe(codeBlock("// b.ts\nx", "ts", "a.ts"));
  });

  test("comments that aren't file names stay code, so prose comments don't turn into captions", () => {
    for (const value of ["// hello world\nx", "// note\nx", "// https://example.com/a.ts\nx", "// config.json\nx", "a\nb\nc\nd\n// late.ts"]) {
      expect(htmlOf(one(code("ts", null, value)))).toBe(codeBlock(value, "ts"));
    }
  });

  test("a file-name comment that empties YAML frontmatter takes the fences with it, as in Expressive Code", () => {
    expect(htmlOf(one(code("md", null, "---\n# docs/a.md\n---\n# Title")))).toBe(codeBlock("# Title", "md", "docs/a.md"));
  });

  test("a static fence after a group's fence is not absorbed into the group, so the embed gets no stray file", () => {
    const out = run(
      [code("ts", 'playground group=g title="index.ts"', "1"), code("ts", 'title="a.ts"', "2"), code("ts", 'playground group=g title="b.ts"', "3")],
      all,
    );
    const [first, block, second] = out.map(htmlOf);
    expect(first!.match(/data-file=/g)).toHaveLength(1);
    expect(first).toContain('data-file="index.ts"');
    expect(block).toBe(codeBlock("2", "ts", "a.ts"));
    expect(second).toContain('data-file="b.ts"');
  });

  test("playground fences still become embeds and load embed.js in the same mode", () => {
    const out = run([code("ts", "playground", "1"), code("ts", null, "2")], all);
    expect(htmlOf(out[0])).toStartWith("<bun-playground");
    expect(htmlOf(out.at(-1))).toContain("embed.js");
  });

  test("a Markdown page with only static blocks links the CSS and the Copy script but never loads embed.js", () => {
    const out = run([code("ts", null, "1")], { ...all, sync: { scheme: "data-theme" } });
    const tail = htmlOf(out.at(-1))!;
    expect(tail).toStartWith('<link rel="stylesheet" href="/_runbun/highlights.css">');
    expect(tail).toContain("data-runbun-copy-script");
    expect(tail).not.toContain("embed.js");
    expect(tail).not.toContain("MutationObserver");
  });

  test("an MDX page with only static blocks imports the CSS (bundled once) and gets the Copy script, no embed.js", () => {
    const out = run([code("ts", null, "1")], all, "page.mdx");
    expect(out[0]).toMatchObject({ type: "mdxjsEsm", value: 'import "virtual:@runbun/astro/blocks.css";' });
    // MDX would empty a raw <script>, so blocks go through <Fragment set:html>.
    expect(out[1]).toMatchObject({ type: "mdxJsxFlowElement", name: "Fragment" });
    expect(htmlOf(out[1])).toBe(codeBlock("1", "ts"));
    const tail = htmlOf(out.at(-1))!;
    expect(tail).toContain("data-runbun-copy-script");
    expect(tail).not.toContain("embed.js");
    expect(tail).not.toContain("<link");
  });

  test("a page whose fences all fall back gets no assets, since nothing of runbun's is on it", () => {
    const out = run([code("sh", null, "x"), code("ts", "wrap", "y")], all);
    expect(out).toEqual([code("sh", null, "x"), code("ts", "wrap", "y")]);
  });

  test("fences nested in lists and quotes are rendered too, and count for the page's assets", () => {
    const out = run([{ type: "blockquote", children: [code("ts", null, "1")] }], all);
    expect(htmlOf((out[0] as { children: RootContent[] }).children[0])).toBe(codeBlock("1", "ts"));
    expect(htmlOf(out[1])).toContain("data-runbun-copy-script");
  });
});

describe("line marks", () => {
  const all = { fences: "all" } as const;
  const one = (node: Code) => htmlOf(run([node], all)[0])!;

  test("highlights' token spans are never nested, which cutting them at line ends relies on", () => {
    for (const [src, lang] of SAMPLES) {
      let depth = 0;
      for (const [tag] of highlight(src, lang).matchAll(/<\/?span\b/g)) {
        depth += tag === "<span" ? 1 : -1;
        expect(depth).toBeLessThanOrEqual(1);
      }
    }
  });

  test("splitting into lines keeps the code's text exactly, so Copy still gets the source", () => {
    for (const [src, lang] of SAMPLES) {
      const html = codeBlock(src, lang, undefined, { mark: [0] });
      expect(text(html)).toBe(src.replace(/\n$/, ""));
      expect(marksOf(html)).toHaveLength(src.replace(/\n$/, "").split("\n").length);
    }
  });

  test("a block without marks is the block it was, so unmarked pages don't change", () => {
    expect(codeBlock("a\nb", "ts", "x.ts", { mark: [], ins: [] })).toBe(codeBlock("a\nb", "ts", "x.ts"));
    expect(codeBlock("a\nb", "ts")).not.toContain('class="line"');
  });

  test("{…}, mark=, ins= and del= mark 1-based inclusive lines, and lines past the end are skipped", () => {
    const html = one(code("ts", "{1} mark={3} ins={2-3} del={4,99}", "a\nb\nc\nd"));
    expect(marksOf(html)).toEqual(["mark", "ins", "mark ins", "del"]);
    expect(text(html)).toBe("a\nb\nc\nd");
  });

  test("marks count the file-name comment's line, as Expressive Code does, so they stay on the lines they meant", () => {
    // elysia-docs' blog: ins={3,9-11,…} under a `// src/modules/authen.ts` first line.
    const html = one(code("ts", "ins={2,4} mark={1}", "// src/a.ts\nimport x\n\nconst a = 1\nconst b = 2"));
    expect(html).toContain("<figcaption>src/a.ts</figcaption>");
    expect(text(html)).toBe("import x\n\nconst a = 1\nconst b = 2");
    // Line 1 (the comment) went with its mark; 2 and 4 are now the first and third.
    expect(marksOf(html)).toEqual(["ins", "", "ins", ""]);
  });

  test("ins and del have their gutter sign in CSS, so the code element's text has no + or −", () => {
    const html = one(code("ts", "ins={1} del={2}", "a\nb"));
    expect(text(html)).toBe("a\nb");
    expect(html).toContain('<code class="runbun-lines">');
  });

  test("<Code>'s mark, ins and del take the fence's ranges, with spaces allowed, and reject anything else loudly", () => {
    expect(propLines({ mark: "1, 4-6", del: "2" })).toEqual({ mark: [0, 3, 4, 5], del: [1] });
    expect(propLines({})).toEqual({});
    expect(() => propLines({ ins: "x" })).toThrow('<Code ins="x">');
  });
});

describe("notes", () => {
  const all = { fences: "all" } as const;
  const list = (...items: string[]): List => ({
    type: "list",
    ordered: true,
    start: 1,
    spread: false,
    children: items.map((value) => ({ type: "listItem", spread: false, children: [{ type: "paragraph", children: [{ type: "text", value }] }] })),
  });
  const props = (node: { data?: unknown } | undefined) => (node?.data as { hProperties?: Record<string, unknown> } | undefined)?.hProperties;
  const targets = (html: string) => [...html.matchAll(/popovertarget="([^"]+)"/g)].map((m) => m[1]);
  /** Runs a fence and the list after it; warnings are caught, so a test can say whether there was one. */
  const annotate = (fence: Code, after: RootContent | undefined, path = "page.md") => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const out = run(after ? [fence, after] : [fence], all, path);
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return { html: htmlOf(out[0])!, list: out[1], warned };
  };

  test("a // (N) marker becomes an empty numbered button at its line's end, and its comment leaves the code", () => {
    const { html, list: notes, warned } = annotate(code("ts", null, "const a = 1; // (1)\nconst b = 2;   // (2)"), list("one", "two"));
    expect(warned).toEqual([]);
    expect(html).toMatch(/<span class="line">.*;<\/span><button type="button" class="runbun-note" popovertarget="runbun-note-[\w]+-0-1" aria-label="Note 1" data-n="1"><\/button><\/span>/);
    expect(html).toContain('aria-label="Note 2" data-n="2"></button>');
    // What Copy reads: no marker, no number, no trailing spaces.
    expect(text(html)).toBe("const a = 1;\nconst b = 2;");
    // The list stays in the page, its items the popovers the buttons open.
    expect(notes?.type).toBe("list");
    expect(props(notes)).toEqual({ className: ["runbun-notes"] });
    const items = (notes as List).children.map(props);
    expect(items.map((p) => p?.popover)).toEqual(["auto", "auto"]);
    expect(targets(html)).toEqual(items.map((p) => p?.id as string));
  });

  test("markers follow each language's comments: # in YAML, <!-- --> in HTML, /* */ in CSS", () => {
    for (const [lang, src, rest] of [
      ["yaml", "a: 1 # (1)", "a: 1"],
      ["html", "<p>hi</p> <!-- (1) -->", "<p>hi</p>"],
      ["css", ".a { color: red } /* (1) */", ".a { color: red }"],
    ] as const) {
      const { html, warned } = annotate(code(lang, null, src), list("n"));
      expect(warned).toEqual([]);
      expect(text(html)).toBe(rest);
      expect(targets(html)).toHaveLength(1);
    }
  });

  test("comments that only look like markers stay code: prose before (N), a template literal, # in TypeScript", () => {
    for (const src of ["setup(); // setup (1)", "const t = `\n// (1)\n`;", "class A { #p = 1 } # (1)", 'const s = "// (1)";']) {
      const { html, list: notes, warned } = annotate(code("ts", null, src), list("n"));
      expect(text(html)).toBe(src);
      expect(html).not.toContain("runbun-note");
      expect(props(notes)).toBeUndefined();
      expect(warned).toEqual([]);
    }
  });

  test("markers without a matching list stay comments, the list stays a list, and the build says which file", () => {
    for (const after of [undefined, list("only one"), list("a", "b", "c"), { type: "list", ordered: false, spread: false, children: list("a", "b").children } as List]) {
      const src = "a(); // (1)\nb(); // (2)";
      const { html, list: notes, warned } = annotate(code("ts", null, src), after, "/site/src/content/docs/x.md");
      expect(text(html)).toBe(src);
      expect(html).not.toContain("runbun-note");
      if (after) expect(props(notes)).toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("/site/src/content/docs/x.md");
    }
  });

  test("ids come from the page's path and the block's place, so a cached page's ids are the same build after build", () => {
    const ids = (path: string) => {
      const out = run([code("ts", null, "x"), code("ts", null, "a(); // (1)"), list("n")], all, path);
      return targets(htmlOf(out[1])!);
    };
    expect(ids("/a.md")).toEqual(ids("/a.md"));
    expect(ids("/a.md")[0]).toMatch(/^runbun-note-\w+-1-1$/);
    expect(ids("/a.md")).not.toEqual(ids("/b.md"));
  });

  test("notes and line marks work together, under a file-name comment, and marks keep the fence's numbering", () => {
    const { html, warned } = annotate(code("ts", "{2} ins={3}", "// src/a.ts\nconst a = 1; // (1)\nconst b = 2;"), list("n"));
    expect(warned).toEqual([]);
    expect(html).toContain("<figcaption>src/a.ts</figcaption>");
    expect(marksOf(html)).toEqual(["mark", "ins"]);
    expect(html).toMatch(/<span class="line" data-mark>.*<button[^>]*data-n="1"><\/button><\/span>\n<span class="line" data-ins>/);
    expect(text(html)).toBe("const a = 1;\nconst b = 2;");
  });

  test("in MDX the block goes through <Fragment set:html> and the list gets the same popover properties", () => {
    const out = run([code("ts", null, "a(); // (1)"), list("n")], all, "page.mdx");
    expect(out[1]).toMatchObject({ type: "mdxJsxFlowElement", name: "Fragment" });
    expect(props(out[2])).toEqual({ className: ["runbun-notes"] });
    expect(targets(htmlOf(out[1])!)).toEqual([props((out[2] as List).children[0])?.id as string]);
  });
});

describe("where fences comes from", () => {
  test('the integration\'s fences: "all" reaches the plugin, so runbun({ fences: "all" }) is all a site sets', () => {
    setConfig({ fences: "all" });
    expect(htmlOf(run([code("ts", null, "1")])[0])).toBe(codeBlock("1", "ts"));
  });

  test("the plugin's own option overrides the integration's, as playgroundUrl, base and sync do", () => {
    setConfig({ fences: "all" });
    expect(run([code("ts", null, "1")], { fences: "playground" })).toEqual([code("ts", null, "1")]);
  });
});
