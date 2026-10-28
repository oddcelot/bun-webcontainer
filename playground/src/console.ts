import type { ITheme, Terminal } from "ghostty-web";
import type { ThemeLike } from "@pierre/theming";
import { onTheme } from "./theme";

// The console pane as a Ghostty terminal (ghostty-web: Ghostty's VT core as wasm), so ANSI output renders.
// The module (~680 kB, wasm inlined) loads after the page is up; lines logged before that are replayed.

const LEVEL_SGR: Record<string, string> = { error: "31", warn: "33", sys: "34" };
const MAX_LINES = 5000;

/** ghostty-web reads hex only; the canvas turns any CSS color (`color(display-p3 ...)` too) into one. */
function toHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Background and foreground match the other panes (style.css's --bg/--fg); the palette is the theme's ANSI colors. */
function terminalTheme(theme: ThemeLike): ITheme {
  const c = theme.colors ?? {};
  const root = getComputedStyle(document.documentElement);
  const ansi = (name: string) => toHex(c[`terminal.ansi${name}`]);
  return {
    background: toHex(root.getPropertyValue("--bg")),
    foreground: toHex(root.getPropertyValue("--fg")),
    cursor: toHex(root.getPropertyValue("--bg")), // output only: no visible cursor
    selectionBackground: toHex(c["terminal.selectionBackground"] ?? c["editor.selectionBackground"]),
    black: ansi("Black"),
    red: ansi("Red"),
    green: ansi("Green"),
    yellow: ansi("Yellow"),
    blue: ansi("Blue"),
    magenta: ansi("Magenta"),
    cyan: ansi("Cyan"),
    white: ansi("White"),
    brightBlack: ansi("BrightBlack"),
    brightRed: ansi("BrightRed"),
    brightGreen: ansi("BrightGreen"),
    brightYellow: ansi("BrightYellow"),
    brightBlue: ansi("BrightBlue"),
    brightMagenta: ansi("BrightMagenta"),
    brightCyan: ansi("BrightCyan"),
    brightWhite: ansi("BrightWhite"),
  };
}

const format = (level: string, text: string) =>
  LEVEL_SGR[level] ? `\x1b[${LEVEL_SGR[level]}m${text}\x1b[0m\r\n` : `${text}\x1b[0m\r\n`;

export function mountConsole(el: HTMLElement) {
  const lines: string[] = [];
  let term: Terminal | undefined;

  const ghostty = import("ghostty-web").then(async (m) => (await m.init(), m));
  // ghostty-web doesn't apply theme changes to an open terminal yet: open a new one and replay.
  onTheme(async (_, theme) => {
    const { Terminal, FitAddon } = await ghostty;
    term?.dispose();
    el.replaceChildren();
    const next = new Terminal({
      theme: terminalTheme(theme),
      fontSize: 12,
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      convertEol: true,
      disableStdin: true,
      scrollback: MAX_LINES,
    });
    const fit = new FitAddon();
    next.loadAddon(fit);
    next.open(el);
    fit.fit();
    fit.observeResize();
    next.write("\x1b[?25l" + lines.join(""));
    term = next;
  });

  return {
    log(level: string, text: string) {
      const line = format(level, text);
      lines.push(line);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      term?.write(line);
    },
    clear() {
      lines.length = 0;
      term?.clear();
      term?.write("\x1b[2J\x1b[H");
    },
  };
}
