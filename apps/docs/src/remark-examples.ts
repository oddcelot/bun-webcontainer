// ````md example fences (guides/astro-examples.mdx): the Markdown source beside what it renders, written once. The
// source shows as code (Expressive Code, as any `md` fence here); the result is that same text parsed by the page's own
// parser (this.parse: MDX on an .mdx page, so ````mdx example can hold <Code> and <Playground>) and put through
// @runbun/astro's fence plugin with `fences: "all"`, so its plain fences become runbun's static blocks while the rest of
// the site keeps Expressive Code. `wide` in the meta stacks the two instead of setting them side by side.
//
// It runs before remarkRunbun (astro.config.ts). Each example's subtree gets its own remarkRunbun pass, under its own
// path (`page.example-3.mdx`), so radio names and note ids from different examples can't meet. What that pass adds for
// the page (the blocks' CSS import or link, the Copy script, embed.js) comes out of each subtree and goes on the page
// once; the page's own pass then leaves the examples alone (their fences are HTML by then, and its default mode skips
// the ones that fell back).
import remarkRunbun from "@runbun/astro/remark";

type Node = { type: string; lang?: string | null; meta?: string | null; value?: string; name?: string; children?: Node[]; data?: unknown; attributes?: { name: string; value: unknown }[] };

/** An element by its hast name (mdast-util-to-hast turns an unknown node with `data.hName` into one). */
const el = (className: string[], children: Node[]): Node => ({ type: "runbunExample", data: { hName: "div", hProperties: { className } }, children });

/** The raw HTML of a node remarkRunbun made: an `html` node, or (MDX) a `<Fragment set:html>`. */
const htmlOf = (n: Node): string => (n.type === "html" ? (n.value ?? "") : n.type === "mdxJsxFlowElement" && n.name === "Fragment" ? String(n.attributes?.find((a) => a.name === "set:html")?.value ?? "") : "");
/** The page assets remarkRunbun appends last: the Copy script, with the stylesheet link and embed.js before it. */
const isAssets = (n: Node) => htmlOf(n).includes("data-runbun-copy-script");
/** The blocks' CSS as an MDX import, which remarkRunbun puts first. */
const isCssImport = (n: Node) => n.type === "mdxjsEsm" && !!n.value?.includes("@runbun/astro/blocks.css");

export default function remarkExamples(this: { parse(text: string): Node }) {
  const parse = (text: string) => this.parse(text);
  return (tree: Node, file?: { path?: string }) => {
    const path = file?.path ?? "page.md";
    let n = 0;
    let css: Node | undefined;
    let assets: Node | undefined;
    const esm = new Map<string, Node>();
    const visit = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const words = (child.meta ?? "").split(/\s+/);
        if (child.type !== "code" || (child.lang !== "md" && child.lang !== "mdx") || !words.includes("example")) {
          visit(child);
          return child;
        }
        const result = parse(child.value ?? "");
        remarkRunbun({ fences: "all" })(result as never, { path: path.replace(/(\.mdx?)?$/, (ext) => `.example-${n++}${ext || ".md"}`) });
        const shown: Node[] = [];
        for (const c of result.children ?? []) {
          if (isCssImport(c)) css ??= c;
          // The richest set: one with embed.js (any example with a playground) over one without.
          else if (isAssets(c)) assets = !assets || (htmlOf(c).includes("embed.js") && !htmlOf(assets).includes("embed.js")) ? c : assets;
          // An MDX example's imports go to the page's top (once each), where MDX takes them.
          else if (c.type === "mdxjsEsm") esm.set(c.value ?? "", c);
          else shown.push(c);
        }
        const label = (text: string) => el(["example-label"], [{ type: "text", value: text }]);
        return el(words.includes("wide") ? ["example", "wide"] : ["example"], [
          el(["example-source"], [label(child.lang === "mdx" ? "MDX" : "Markdown"), { type: "code", lang: child.lang, meta: null, value: child.value }]),
          el(["example-result"], [label("Result"), ...shown]),
        ]);
      });
    };
    visit(tree);
    tree.children ??= [];
    tree.children.unshift(...esm.values(), ...(css ? [css] : []));
    if (assets) tree.children.push(assets);
  };
}
