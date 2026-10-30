import { Show, useContext } from "solid-js";
import { DOCS } from "../base";
import { formatChord, keysFor, type Command } from "../keymap";
import { BUN_VERSION } from "../worker/bunVersion";
import { AppContext } from "./context";

/** What Bun treats a file as, by extension (its loader), named as editors do. */
const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  txt: "Plain Text",
};

const language = (path: string) => {
  const ext = /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
  return (ext && LANGUAGES[ext]) ?? "Plain Text";
};

const withKeys = (text: string, command: Command) => [text, ...keysFor(command).map(formatChord)].join(" · ");

/**
 * The bar along the bottom, as in VS Code or Zed: panel toggles and the program's status on the left, the open
 * file's problems, cursor and language and the Bun release on the right.
 */
export function StatusBar(props: { previewShown: boolean; consoleShown: boolean; toggle(i: number): void }) {
  const app = useContext(AppContext);
  const s = app.session;
  const ws = app.workspace;
  const count = (severity: "error" | "warning") => ws.problems().filter((d) => d.severity === severity).length;
  // Each click jumps to the next problem after the cursor, wrapping around.
  const nextProblem = () => {
    const list = [...ws.problems()].sort((a, b) => a.line - b.line || a.column - b.column);
    if (!list.length) return;
    const at = ws.cursor();
    const after = at && list.find((d) => d.line > at.line || (d.line === at.line && d.column > at.column));
    const d = after ?? list[0];
    ws.reveal(d.line, d.column);
  };

  return (
    <footer id="statusbar">
      <button type="button" aria-pressed={props.previewShown ? "true" : "false"} title={withKeys("Show or hide the preview", "togglePreview")} onClick={() => props.toggle(0)}>
        <i class="i-lucide-app-window" aria-hidden="true" />
        <span class="sr-only">Preview</span>
      </button>
      <button type="button" aria-pressed={props.consoleShown ? "true" : "false"} title={withKeys("Show or hide the console", "toggleConsole")} onClick={() => props.toggle(1)}>
        <i class="i-lucide-square-terminal" aria-hidden="true" />
        <span class="sr-only">Console</span>
      </button>
      <span id="status" role="status" data-state={s.status().state} title={s.status().text}>
        <span class="text">{s.status().text}</span>
      </span>
      <span class="spacer" />
      <Show when={ws.state.active}>
        {(path) => (
          <>
            <button
              type="button"
              class="problems"
              disabled={!ws.problems().length}
              title={ws.problems().length ? "Go to the next problem in this file" : "No problems in this file"}
              onClick={nextProblem}
            >
              <i class="i-lucide-circle-x" aria-hidden="true" /> {count("error")}
              <span class="sr-only">errors,</span>
              <i class="i-lucide-triangle-alert" aria-hidden="true" /> {count("warning")}
              <span class="sr-only">warnings</span>
            </button>
            <Show when={ws.cursor()}>
              {(c) => (
                <span class="cursor" title="Line and column">
                  Ln {c().line}, Col {c().column}
                  {c().selected ? ` (${c().selected} selected)` : ""}
                </span>
              )}
            </Show>
            <span class="language" title="What the file is read as">
              {language(path())}
            </span>
          </>
        )}
      </Show>
      <a href={`${DOCS}compatibility/bun/`} target="_blank" rel="noopener" title="The Bun release these crates are built from: what works (opens in a new tab)">
        Bun {BUN_VERSION}
      </a>
    </footer>
  );
}
