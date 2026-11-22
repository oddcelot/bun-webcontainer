#!/usr/bin/env bun
// SPIKE (bwc-me5n): time-to-first-preview, the real path (bun install, worker, Bun.serve) against the import-map fast
// path (src/fastPath.ts, `?fast`), on browser-only React and Solid projects, in headless Chrome.
//   bun scripts/fast-path.ts                 both projects, 3 cold runs (fresh profile) + 3 warm runs (same profile) each
//   RUNS=1 bun scripts/fast-path.ts react    one project, one run
//   DIST=/path/to/vite-build bun ...         serve a production build (vite preview) instead of the dev server
// Time-to-first-preview: from navigating the host page until `#root main h1` exists in the preview frame.
// Port 5180 (the editor) and 5182 (the host page), not the dev servers other agents use.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const app = join(import.meta.dir, "..");
const PORT = Number(process.env.EDITOR_PORT ?? 5180);
const HOST_PORT = Number(process.env.HOST_PORT ?? 5182);
const RUNS = Number(process.env.RUNS ?? 3);
const EDITOR = `http://localhost:${PORT}`;

const common = {
  react: {
    "package.json": JSON.stringify({ name: "fast-react", type: "module", dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }, null, 2),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "Preserve", moduleResolution: "bundler" } }),
    "src/App.tsx": `import { useState } from "react";
export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Bun + React</h1>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
    </main>
  );
}
`,
    "src/frontend.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
`,
    "src/styles.css": `body { font-family: system-ui; margin: 2rem; } h1 { color: rebeccapurple; }\n`,
  },
  solid: {
    "package.json": JSON.stringify({ name: "fast-solid", type: "module", dependencies: { "solid-js": "^1.9.0" } }, null, 2),
    "src/main.ts": `import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import html from "solid-js/html";
import "./styles.css";
function App() {
  const [n, setN] = createSignal(0);
  return html\`<main><h1>Bun + Solid</h1><button onClick=\${() => setN(n() + 1)}>Clicked \${n} times</button></main>\`;
}
render(App, document.getElementById("root")!);
`,
    "src/styles.css": `body { font-family: system-ui; margin: 2rem; } h1 { color: teal; }\n`,
  },
  // A bigger dependency tree: what `bun install` has to fetch grows, what esm.sh serves per import doesn't much.
  heavy: {
    "package.json": JSON.stringify({ name: "fast-heavy", type: "module", dependencies: { react: "^19.2.0", "react-dom": "^19.2.0", "react-router": "^7.9.0", "date-fns": "^4.1.0", "lodash-es": "^4.17.21", zod: "^4.1.0", "@tanstack/react-query": "^5.90.0", "framer-motion": "^12.0.0" } }, null, 2),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "Preserve", moduleResolution: "bundler" } }),
    "src/App.tsx": `import { useState } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { format } from "date-fns";
import { debounce } from "lodash-es";
import { z } from "zod";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { motion } from "framer-motion";
const client = new QueryClient();
const year = z.number().parse(Number(format(new Date(0), "yyyy")));
const log = debounce(() => {}, 10);
export function App() {
  const [count, setCount] = useState(0);
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<main><motion.h1 animate={{ opacity: 1 }}>Heavy {year}</motion.h1><button onClick={() => (log(), setCount((c) => c + 1))}>Clicked {count} times</button></main>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
`,
    "src/frontend.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
`,
    "src/styles.css": `body { font-family: system-ui; margin: 2rem; }\n`,
  },
} as const;
const script = { react: "frontend.tsx", solid: "main.ts", heavy: "frontend.tsx" } as const;
type Project = keyof typeof common;

/** The same sources two ways: `base` with a Bun.serve entry (the usual path), `fast` with a root index.html and no server. */
function filesOf(project: Project, variant: "base" | "fast"): Record<string, string> {
  const page = (src: string) => `<!doctype html>\n<html><head><meta charset="UTF-8" /><title>${project}</title>\n<link rel="stylesheet" href="${src}styles.css" /></head>\n<body><div id="root"></div>\n<script type="module" src="${src}${script[project]}"></script></body></html>\n`;
  if (variant === "fast") return { ...common[project], "index.html": page("./src/") };
  return {
    ...common[project],
    "src/index.html": page("./"),
    "index.ts": `import homepage from "./src/index.html";\nBun.serve({ routes: { "/": homepage } });\n`,
  };
}

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) {
  console.error("no Chrome found: set CHROME to its binary");
  process.exit(1);
}

const only = process.argv.slice(2) as Project[];
const projects = (Object.keys(common) as Project[]).filter((p) => !only.length || only.includes(p));

const editor = process.env.DIST
  ? Bun.spawn(["bunx", "vite", "preview", "--outDir", process.env.DIST, "--port", String(PORT), "--strictPort"], { cwd: app, stdout: "pipe", stderr: "pipe" })
  : Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], { cwd: app, stdout: "pipe", stderr: "pipe", env: { ...process.env, VITE_CACHE_DIR: join(app, "node_modules/.vite-fast") } });
let currentFiles: Record<string, string> = {};
const host = Bun.serve({
  port: HOST_PORT,
  fetch(req) {
    const fast = new URL(req.url).searchParams.has("fast");
    return new Response(
      `<!doctype html><body><iframe id="f" style="width:1000px;height:700px" src="${EDITOR}/embed?init=1&mode=result${fast ? "&fast" : ""}"></iframe>
<script>
  window.events = []; window.lines = [];
  const files = ${JSON.stringify(currentFiles).replaceAll("<", "\\u003c")};
  addEventListener("message", (e) => {
    const d = e.data;
    if (d?.bunPlayground !== 1 || !d.event) return;
    window.events.push([d.event, Date.now()]);
    if (d.event === "boot") f.contentWindow.postMessage({ bunPlayground: 1, id: 1, method: "init", params: { files } }, "${EDITOR}");
    if (d.event === "console") window.lines.push(...d.data.text.split("\\n"));
  });
</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

type Sample = { total: number; ready?: number; lines: string[] };

/** One load of the host page: ms until the preview shows the heading (null: it didn't within the limit). */
async function load(browser: Browser, fast: boolean): Promise<Sample | null> {
  const page: Page = await browser.newPage();
  try {
    const start = Date.now();
    await page.goto(`http://localhost:${HOST_PORT}/${fast ? "?fast" : ""}`, { waitUntil: "domcontentloaded" });
    let total: number | null = null;
    while (Date.now() - start < 120_000) {
      for (const frame of page.frames()) {
        try {
          if (!/__preview|about:srcdoc/.test(frame.url())) continue;
          if (await frame.evaluate(() => !!document.querySelector("#root main h1"))) total = Date.now() - start;
        } catch {} // a frame that navigated meanwhile
      }
      if (total !== null) break;
      await Bun.sleep(15);
    }
    const info = await page.evaluate(() => ({ events: (window as unknown as { events: [string, number][] }).events, lines: (window as unknown as { lines: string[] }).lines }));
    const ready = info.events.find((e) => e[0] === "ready")?.[1];
    if (total === null) {
      console.error(`  didn't show: events ${JSON.stringify(info.events.map((e) => e[0]))}\n  ${info.lines.slice(-8).join("\n  ")}`);
      return null;
    }
    return { total, ready: ready ? ready - start : undefined, lines: info.lines };
  } finally {
    await page.close();
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows: string[] = [];
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${EDITOR}/`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error(`the editor didn't come up:\n${await new Response(editor.stderr).text()}`);
    await Bun.sleep(200);
  }
  // The dev server compiles on first request: one throwaway load so the cold runs below measure the playground, not Vite.
  {
    const profile = mkdtempSync(join(tmpdir(), "fast-path-warmup-"));
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
    try {
      currentFiles = filesOf(projects[0], "base");
      await load(browser, false);
      currentFiles = filesOf(projects[0], "fast");
      await load(browser, true);
    } finally {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
  for (const project of projects) {
    for (const variant of ["base", "fast"] as const) {
      currentFiles = filesOf(project, variant);
      const cold: number[] = [];
      const warm: number[] = [];
      const readyCold: number[] = [];
      const readyWarm: number[] = [];
      let sample: Sample | undefined;
      for (let run = 0; run < RUNS; run++) {
        const profile = mkdtempSync(join(tmpdir(), "fast-path-"));
        const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile });
        try {
          const c = await load(browser, variant === "fast");
          if (c) (cold.push(c.total), readyCold.push(c.ready ?? NaN), (sample = c));
          for (let w = 0; w < 2; w++) {
            const r = await load(browser, variant === "fast");
            if (r) (warm.push(r.total), readyWarm.push(r.ready ?? NaN));
          }
        } finally {
          await browser.close();
          rmSync(profile, { recursive: true, force: true });
        }
      }
      const fmt = (xs: number[]) => (xs.length ? `median ${median(xs)} ms [${xs.join(", ")}]` : "never showed");
      rows.push(`${project.padEnd(6)} ${variant.padEnd(4)} cold ${fmt(cold)}  (page ready ${readyCold.length ? median(readyCold) : "-"})\n${"".padEnd(12)} warm ${fmt(warm)}  (page ready ${readyWarm.length ? median(readyWarm) : "-"})`);
      console.log(rows.at(-1));
      if (sample && process.env.LINES) console.log(sample.lines.filter((l) => /fast|install/i.test(l)).join("\n"));
    }
  }
} finally {
  host.stop(true);
  editor.kill();
  await editor.exited;
}
console.log(`\n${rows.join("\n")}`);
