import type { ITheme, Terminal } from "@xterm/xterm";
import type { ThemeLike } from "@pierre/theming";
import { onTheme } from "./theme";

// The console pane as an xterm.js terminal, so ANSI output renders. xterm loads once the pane is attached;
// lines logged before that are written once it's open.

const LEVEL_SGR: Record<string, string> = { error: "31", warn: "33", sys: "34" };
const MAX_LINES = 5000;

/**
 * xterm's DOM renderer keeps CSS colors as written (`color(display-p3 ...)` too), but its parser throws on
 * translucent colors other than hex and rgba(); turn those into rgba().
 */
function cssColor(color: string | undefined): string | undefined {
  color = color?.trim();
  if (!color || /^(#|rgba?\()/i.test(color)) return color || undefined;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? color : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** `color` at `alpha` opacity, as rgba (xterm's theme takes plain colors, not color-mix()). */
function withAlpha(color: string, alpha: number): string | undefined {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = color.trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Background and foreground match the other panes (style.css's --bg/--fg); the palette is the theme's ANSI colors. */
function terminalTheme(theme: ThemeLike): ITheme {
  const c = theme.colors ?? {};
  const root = getComputedStyle(document.documentElement);
  const ansi = (name: string) => cssColor(c[`terminal.ansi${name}`]);
  return {
    background: cssColor(root.getPropertyValue("--bg")),
    foreground: cssColor(root.getPropertyValue("--fg")),
    cursor: cssColor(root.getPropertyValue("--fg")),
    selectionBackground: cssColor(c["terminal.selectionBackground"] ?? c["editor.selectionBackground"]),
    // style.css's --scrollbar and --scrollbar-hover.
    scrollbarSliderBackground: withAlpha(root.getPropertyValue("--fg"), 0.22),
    scrollbarSliderHoverBackground: withAlpha(root.getPropertyValue("--fg"), 0.38),
    scrollbarSliderActiveBackground: withAlpha(root.getPropertyValue("--fg"), 0.5),
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

/** `index.ts:3:7`, `/src/app.tsx:12`: after a space, `(` or a line's start, so a URL's path isn't one. */
const LOCATION = /(?<=^|[\s(])(\/?[\w.@\-/]*\.(?:[cm]?[jt]sx?|json|css|html|md)):(\d+)(?::(\d+))?/g;

const PROMPT = "\x1b[32m❯\x1b[0m ";
/** The prompt, with the shell's folder before it once it isn't the project's root (`src ❯`). */
const promptFor = (cwd: string) => (cwd === "/" ? PROMPT : `\x1b[34m${cwd.slice(1)}\x1b[0m ${PROMPT}`);
// One input unit: an escape sequence (arrows, Home/End, Delete) or a single character.
const TOKENS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/gu;

/**
 * A prompt with line editing (arrows, Home/End, history, Ctrl+A/E/U/C/L, paste). `onCommand` runs each
 * entered line; the prompt comes back when it settles. Output logged meanwhile prints above the prompt.
 * Ctrl+C on an empty line calls `onInterrupt` (stop the server, like a shell's SIGINT). A `file.ts:3:7` location (in a
 * stack trace, an error) is a link when `isFile` knows the file; clicking it calls `onLocation`.
 */
export function createConsole(
  { onCommand, onInterrupt, onClear, isFile, onLocation, cwd = () => "/" }: {
    onCommand: (line: string) => Promise<void>;
    /** The shell's folder, shown in the prompt. */
    cwd?: () => string;
    onInterrupt: () => void;
    onClear: () => void;
    /** Whether `path` is a project file (only those locations are links). */
    isFile: (path: string) => boolean;
    /** Opens `path` at a 1-based line and column. */
    onLocation: (path: string, line: number, column: number) => void;
  },
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
    return "\r\x1b[2K" + promptFor(cwd()) + input + (back ? `\x1b[${back}D` : "");
  };
  const redraw = () => !busy && term?.write(promptLine());

  async function enter() {
    const line = input.trim();
    term?.write("\r\x1b[2K" + promptFor(cwd()) + input + "\r\n");
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

  const xterm = () =>
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
      import("@xterm/addon-unicode-graphemes"),
      import("@xterm/xterm/css/xterm.css"),
    ]);
  let latest: ThemeLike | undefined;
  let resize: ResizeObserver | undefined;

  async function open(el: HTMLElement, attached: () => boolean): Promise<Terminal | undefined> {
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { UnicodeGraphemesAddon }] = await xterm();
    if (!attached()) return;
    // style.css's --font-mono, which a host can override (the embed's vars), like the editor's font.
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
    const next = new Terminal({
      theme: terminalTheme(latest!),
      fontSize: 12,
      fontFamily: mono || "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: MAX_LINES,
      allowProposedApi: true, // the graphemes addon sets unicode.activeVersion
      // Sizes the scrollbar too (xterm's default is 14px), matching the other panes' thin ones. Nothing draws
      // decorations, so the ruler itself stays empty.
      overviewRuler: { width: 8 },
    });
    const fit = new FitAddon();
    for (const addon of [fit, new WebLinksAddon(), new UnicodeGraphemesAddon()]) next.loadAddon(addon);
    next.open(el);
    next.registerLinkProvider({
      provideLinks(y, done) {
        const text = next.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = [...text.matchAll(LOCATION)].flatMap((m) => {
          const [all, path, line, column] = m;
          if (!isFile(path)) return [];
          return [{
            range: { start: { x: m.index + 1, y }, end: { x: m.index + all.length, y } },
            text: all,
            activate: () => onLocation(path, Number(line), Number(column ?? 1)),
          }];
        });
        done(links.length ? links : undefined);
      },
    });
    fit.fit();
    resize = new ResizeObserver(() => fit.fit());
    resize.observe(el);
    next.onData((data) => {
      for (const [t] of data.matchAll(TOKENS)) key(t);
    });
    // The transcript replays into every terminal that opens, so output logged before it (or into one that
    // was replaced) isn't lost.
    if (lines.length) next.write(lines.join(""));
    term = next;
    redraw();
    return next;
  }

  let detach: (() => void) | undefined;

  const api = {
    /**
     * Opens the terminal in `el` (on the first theme; later ones restyle it in place). Returns the detach.
     * One element at a time: Solid can run the pane's setup for a render it then discards, and a new attach
     * replaces the last, so the terminal that receives output and themes is the one on screen.
     */
    attach(el: HTMLElement) {
      detach?.();
      let attached = true;
      let mine: Terminal | undefined;
      let opening: Promise<unknown> | undefined;
      const untheme = onTheme((_, theme) => {
        latest = theme;
        if (mine) mine.options.theme = terminalTheme(theme);
        else opening ??= open(el, () => attached).then((t) => void (mine = t));
      });
      const off = () => {
        if (!attached) return;
        attached = false;
        untheme();
        resize?.disconnect();
        mine?.dispose();
        if (term === mine) term = undefined;
        if (detach === off) detach = undefined;
      };
      return (detach = off);
    },
    log(level: string, text: string) {
      const line = format(level, text);
      push(line);
      if (!term) return;
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
