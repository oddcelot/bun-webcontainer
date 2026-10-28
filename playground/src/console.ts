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
    cursor: toHex(root.getPropertyValue("--fg")),
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

const PROMPT = "\x1b[32m❯\x1b[0m ";
// One input unit: an escape sequence (arrows, Home/End, Delete) or a single character.
const TOKENS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/gu;

/**
 * A prompt with line editing (arrows, Home/End, history, Ctrl+A/E/U/C/L, paste). `onCommand` runs each
 * entered line; the prompt comes back when it settles. Output logged meanwhile prints above the prompt.
 * Ctrl+C on an empty line calls `onInterrupt` (stop the server, like a shell's SIGINT).
 */
export function mountConsole(
  el: HTMLElement,
  { onCommand, onInterrupt, onClear }: { onCommand: (line: string) => Promise<void>; onInterrupt: () => void; onClear: () => void },
) {
  const lines: string[] = [];
  let term: Terminal | undefined;
  let input = "";
  let cursor = 0;
  let busy = false;
  const history: string[] = [];
  let recall = 0; // index into history; history.length = the line being typed

  const push = (line: string) => {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  };
  const promptLine = () => {
    const back = [...input.slice(cursor)].length;
    return "\r\x1b[2K" + PROMPT + input + (back ? `\x1b[${back}D` : "");
  };
  const redraw = () => !busy && term?.write(promptLine());

  async function enter() {
    const line = input.trim();
    term?.write("\r\x1b[2K" + PROMPT + input + "\r\n");
    push(PROMPT + input + "\r\n");
    input = "";
    cursor = 0;
    if (line && history.at(-1) !== line) history.push(line);
    recall = history.length;
    if (line) {
      busy = true;
      try {
        await onCommand(line);
      } finally {
        busy = false;
      }
    }
    redraw();
  }

  function key(t: string) {
    if (t === "\r" || t === "\n") return void enter();
    if (busy) return t === "\x03" && onInterrupt();
    switch (t) {
      case "\x7f": // Backspace
      case "\b":
        if (cursor > 0) (input = input.slice(0, cursor - 1) + input.slice(cursor)), cursor--;
        break;
      case "\x1b[3~": // Delete
        input = input.slice(0, cursor) + input.slice(cursor + 1);
        break;
      case "\x1b[D":
        cursor = Math.max(0, cursor - 1);
        break;
      case "\x1b[C":
        cursor = Math.min(input.length, cursor + 1);
        break;
      case "\x1b[H":
      case "\x1bOH":
      case "\x01":
        cursor = 0;
        break;
      case "\x1b[F":
      case "\x1bOF":
      case "\x05":
        cursor = input.length;
        break;
      case "\x1b[A":
      case "\x1b[B":
        recall = Math.max(0, Math.min(history.length, recall + (t === "\x1b[A" ? -1 : 1)));
        input = history[recall] ?? "";
        cursor = input.length;
        break;
      case "\x15": // Ctrl+U
        input = input.slice(cursor);
        cursor = 0;
        break;
      case "\x03": // Ctrl+C
        if (!input) onInterrupt();
        term?.write(promptLine() + "^C\r\n");
        input = "";
        cursor = 0;
        break;
      case "\x0c": // Ctrl+L
        onClear();
        return;
      default:
        if (t < " " || t.startsWith("\x1b")) return;
        input = input.slice(0, cursor) + t + input.slice(cursor);
        cursor += t.length;
    }
    redraw();
  }

  const ghostty = import("ghostty-web").then(async (m) => (await m.init(), m));
  // ghostty-web doesn't apply theme changes to an open terminal yet: open a new one and replay.
  onTheme(async (_, theme) => {
    const { Terminal, FitAddon } = await ghostty;
    const focused = !!term && el.contains(document.activeElement);
    term?.dispose();
    el.replaceChildren();
    const next = new Terminal({
      theme: terminalTheme(theme),
      fontSize: 12,
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: MAX_LINES,
    });
    const fit = new FitAddon();
    next.loadAddon(fit);
    next.open(el);
    fit.fit();
    fit.observeResize();
    next.onData((data) => {
      for (const [t] of data.matchAll(TOKENS)) key(t);
    });
    // An empty write throws in ghostty-web 0.4 (a zero-length allocation lands past wasm memory).
    if (lines.length) next.write(lines.join(""));
    term = next;
    redraw();
    if (focused) next.focus();
  });

  const api = {
    log(level: string, text: string) {
      const line = format(level, text);
      push(line);
      // Above the prompt: clear its row, print, draw it again.
      term?.write((busy ? "" : "\r\x1b[2K") + line);
      redraw();
    },
    clear() {
      lines.length = 0;
      term?.clear();
      term?.write("\x1b[2J\x1b[H");
      redraw();
    },
    focus: () => term?.focus(),
  };
  return api;
}
