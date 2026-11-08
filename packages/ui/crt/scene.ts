// A drawing of the playground for the CRT (shader.ts): header, file tree, editor, preview and console, in the
// playground's layout and colors, with the code typing itself out.

const CODE = [
  [["k", "const "], ["v", "server"], ["p", " = "], ["t", "Bun"], ["p", "."], ["f", "serve"], ["p", "({"]],
  [["p", "  "], ["v", "routes"], ["p", ": {"]],
  [["p", "    "], ["s", '"/"'], ["p", ": () => "], ["k", "new "], ["t", "Response"], ["p", "("], ["s", '"Hello from Bun!"'], ["p", "),"]],
  [["p", "    "], ["s", '"/api/time"'], ["p", ": () =>"]],
  [["p", "      "], ["t", "Response"], ["p", "."], ["f", "json"], ["p", "({ "], ["v", "now"], ["p", ": "], ["k", "new "], ["t", "Date"], ["p", "() }),"]],
  [["p", "  },"]],
  [["p", "});"]],
  [],
  [["t", "console"], ["p", "."], ["f", "log"], ["p", "("], ["s", "`Listening on ${"], ["v", "server"], ["p", "."], ["v", "url"], ["s", "}`"], ["p", ");"]],
] as const;
const FILES = ["client.ts", "index.html", "index.ts", "package.json", "styles.css", "util.ts"];

/** The playground's colors: the page's theme variables (the playground's theme.ts), or its dark defaults. */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    canvas: read("--canvas", "#171717"),
    panel: read("--panel", "#0a0a0a"),
    fg: read("--fg", "#e5e5e5"),
    muted: read("--muted", "#8a8a8a"),
    border: read("--border", "#2a2a2a"),
    accent: read("--accent", "#3b82f6"),
  };
}
const SYNTAX: Record<string, string> = { k: "#ff678d", v: "#ffca00", t: "#ffa359", f: "#9d6afb", s: "#5ecc71", p: "#a3a3a3" };

/**
 * The playground, drawn in its own layout (header, file tree, editor, preview and console) at `k` canvas pixels per CSS
 * pixel of a `w` × `h` window. `typed` is how many characters of the code are shown, for the typing animation.
 */
export function drawPlayground(g: CanvasRenderingContext2D, w: number, h: number, k: number, typed: number, time: number) {
  const c = themeColors();
  const box = (x: number, y: number, bw: number, bh: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(x * k, y * k, bw * k, bh * k, 8 * k);
    g.fill();
  };
  const text = (s: string, x: number, y: number, color: string, size = 13, font = "ui-sans-serif, system-ui, sans-serif") => {
    g.fillStyle = color;
    g.font = `${size * k}px ${font}`;
    g.fillText(s, x * k, y * k);
    return g.measureText(s).width / k;
  };
  g.fillStyle = c.canvas;
  g.fillRect(0, 0, w * k, h * k);
  // Header: logo, title, project, Run.
  g.fillStyle = "#fbf0df";
  g.beginPath();
  g.arc(22 * k, 20 * k, 9 * k, 0, Math.PI * 2);
  g.fill();
  text("Bun playground", 40, 25, c.fg, 13);
  box(108, 7, 120, 26, c.panel);
  text("Demo", 118, 25, c.fg, 12);
  box(238, 7, 70, 26, c.panel);
  text("▶ Run", 250, 25, c.fg, 12);
  box(w - 70, 7, 62, 26, c.panel);
  text("Share", w - 58, 25, c.fg, 12);
  // Panels.
  const top = 42;
  const bottom = h - 32;
  const side = Math.min(170, w * 0.14);
  const right = w * 0.42;
  const editorX = 8 + side + 8;
  const editorW = w - right - editorX - 8;
  box(8, top, side, bottom - top, c.panel);
  box(editorX, top, editorW, bottom - top, c.panel);
  box(w - right, top, right - 8, (bottom - top) * 0.45, c.panel);
  box(w - right, top + (bottom - top) * 0.45 + 8, right - 8, (bottom - top) * 0.55 - 8, c.panel);
  // File tree.
  FILES.forEach((name, i) => {
    if (name === "index.ts") box(14, top + 52 + i * 24, side - 12, 22, c.border);
    text(name, 26, top + 68 + i * 24, c.fg, 13);
  });
  box(14, top + 8, side - 12, 26, c.canvas);
  text("Search...", 22, top + 26, c.muted, 12);
  // Editor: a tab, line numbers and the code, typed out.
  text("index.ts", editorX + 14, top + 24, c.fg, 13);
  g.fillStyle = c.accent;
  g.fillRect((editorX + 8) * k, (top + 32) * k, 70 * k, 2 * k);
  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  let left = typed;
  let cursor: [number, number] | null = null;
  CODE.forEach((line, i) => {
    const y = top + 70 + i * 22;
    text(String(i + 1), editorX + 18, y, c.muted, 14, mono);
    let x = editorX + 52;
    for (const [kind, s] of line) {
      if (left <= 0) break;
      const shown = s.slice(0, left);
      left -= s.length;
      x += text(shown, x, y, SYNTAX[kind], 14, mono);
    }
    if (left >= 0 || !cursor) cursor = [x, y];
    left -= 1; // the newline
  });
  if (cursor && Math.floor(time * 2) % 2 === 0) {
    g.fillStyle = c.fg;
    g.fillRect(cursor[0] * k + k, (cursor[1] - 14) * k, 2 * k, 18 * k);
  }
  // Preview and console.
  const px = w - right + 16;
  text("Hello from Bun!", px, top + 70, c.fg, 16);
  const consoleTop = top + (bottom - top) * 0.45 + 8;
  text("Console", px, consoleTop + 24, c.fg, 13);
  text("[run] index.ts", px, consoleTop + 54, SYNTAX.f, 13, mono);
  if (typed >= TOTAL) text("Listening on http://localhost:3000/", px, consoleTop + 74, c.fg, 13, mono);
  text("Ready", 22, h - 11, c.muted, 12);
}
/** How many characters the code has, for `typed`. */
export const TOTAL = CODE.reduce((n, line) => n + line.reduce((m, [, s]) => m + s.length, 0) + 1, 0);

