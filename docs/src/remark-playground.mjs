// Turns ```ts playground … fences into runnable <bun-playground> embeds. The original code block stays inside a
// `slot="poster"` wrapper, so Expressive Code renders it as usual until a click starts the embed.
//
// Meta words: `playground` (required), `mode=…`, `features=…`, `group=<name>`, `load=…`, `height=…`; `title="x.ts"`
// names the file. Consecutive fences with the same `group` share one embed (the first fence's options apply).

const OWN_KEYS = new Set(["playground", "mode", "features", "group", "load", "height", "autorun", "readonly", "persist", "theme", "file"]);
const EXT = { typescript: "ts", javascript: "js", markdown: "md", json: "json", jsonc: "json", html: "html", css: "css", tsx: "tsx", jsx: "jsx", ts: "ts", js: "js", mjs: "mjs", sh: "sh", bash: "sh" };

/** Splits `a b=c title="d e"` into [key, value|null, raw] tokens. */
function tokens(meta) {
  const out = [];
  const re = /(?:([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?)|(\S+)/g;
  let m;
  while ((m = re.exec(meta))) out.push({ key: m[1], value: m[2] ?? m[3] ?? m[4] ?? null, raw: m[0] });
  return out;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const html = (value) => ({ type: "html", value });

function parse(node) {
  const toks = tokens(node.meta ?? "");
  if (!toks.some((t) => t.key === "playground" && t.value === null)) return null;
  const opts = {};
  const keep = [];
  for (const t of toks) {
    if (t.key && OWN_KEYS.has(t.key)) opts[t.key] = t.value ?? "";
    else keep.push(t.raw);
  }
  const title = toks.find((t) => t.key === "title")?.value;
  return { opts, title, node, meta: keep.join(" ") || null };
}

function embed(entries) {
  const { opts } = entries[0];
  for (const e of entries) e.node.meta = e.meta;
  const used = new Set();
  const scripts = entries.map(({ title, node }) => {
    const ext = EXT[node.lang ?? ""] ?? node.lang ?? "txt";
    let name = title || `index.${ext}`;
    for (let n = 2; used.has(name); n++) name = `index${n}.${ext}`;
    used.add(name);
    const body = node.value.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
    return `<script type="text/plain" data-file="${esc(name)}">\n${body}\n</script>`;
  });
  const attrs = ["load", "mode", "features", "height", "autorun", "readonly", "persist", "theme", "file"]
    .filter((k) => k !== "load" && k in opts)
    .map((k) => ` ${k}="${esc(opts[k])}"`)
    .join("");
  const load = ` load="${esc(opts.load || "click")}"`;
  return [
    html(`<bun-playground${load}${attrs}>\n${scripts.join("\n")}\n<div slot="poster">`),
    ...entries.map((e) => e.node),
    html(`</div>\n</bun-playground>`),
  ];
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
    out.push(...embed(entries));
  }
  children.splice(0, children.length, ...out);
  return found;
}

export default function remarkPlayground({ playgroundUrl = "https://runbun.dev/" } = {}) {
  const base = playgroundUrl.endsWith("/") ? playgroundUrl : playgroundUrl + "/";
  return (tree) => {
    if (!transform(tree.children)) return;
    tree.children.push(
      html(
        `<script type="module" src="${esc(base)}embed.js"></script>\n` +
          `<script type="module">\n` +
          `const sync = () => { const t = document.documentElement.dataset.theme === "light" ? "light" : "dark"; for (const el of document.querySelectorAll("bun-playground")) el.setAttribute("theme", t); };\n` +
          `sync(); new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });\n` +
          `</script>`,
      ),
    );
  };
}
