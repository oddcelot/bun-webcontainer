import { Show, useContext } from "solid-js";
import { DOCS } from "../base";
import { formatChord, keysFor, type Command } from "../keymap";
import { TYPED } from "../typecheck";
import { TS_VERSION, TSRS_VERSION } from "../typecheck/tsrsLs";
import { BUN_VERSION } from "../worker/bunVersion";
import { AppContext } from "./context";
import { Shortcuts } from "./Shortcuts";
import { Tip } from "./Tip";

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

// The TypeScript version the checker ports, as "7.1".
const TS_SHORT = TS_VERSION.split(".").slice(0, 2).join(".");

const keys = (command: Command) => keysFor(command).map(formatChord);

/**
 * The bar along the bottom, as in VS Code or Zed: panel toggles and the program's status on the left, the open
 * file's problems, cursor and language, the keyboard shortcuts and the Bun release on the right.
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
      <Tip tip="Show or hide the preview" keys={keys("togglePreview")} type="button" aria-pressed={props.previewShown ? "true" : "false"} onClick={() => props.toggle(0)}>
        <i class="i-lucide-app-window" aria-hidden="true" />
        <span class="sr-only">Preview</span>
      </Tip>
      <Tip tip="Show or hide the console" keys={keys("toggleConsole")} type="button" aria-pressed={props.consoleShown ? "true" : "false"} onClick={() => props.toggle(1)}>
        <i class="i-lucide-square-terminal" aria-hidden="true" />
        <span class="sr-only">Console</span>
      </Tip>
      <span id="status" role="status" data-state={s.status().state} title={s.status().text}>
        <span class="text">{s.status().text}</span>
      </span>
      <span class="spacer" />
      <Show when={ws.state.active}>
        {(path) => (
          <>
            {/* aria-disabled, not disabled: a disabled button gets no pointer events, so no tooltip. */}
            <Tip
              tip={ws.problems().length ? "Go to the next problem in this file" : "No problems in this file"}
              type="button"
              class="problems"
              aria-disabled={ws.problems().length ? undefined : "true"}
              onClick={nextProblem}
            >
              <i class="i-lucide-circle-x" aria-hidden="true" /> {count("error")}
              <span class="sr-only">errors,</span>
              <i class="i-lucide-triangle-alert" aria-hidden="true" /> {count("warning")}
              <span class="sr-only">warnings</span>
            </Tip>
            <Show when={ws.cursor()}>
              {(c) => (
                <Tip as="span" class="cursor" tip="Line and column">
                  Ln {c().line}, Col {c().column}
                  {c().selected ? ` (${c().selected} selected)` : ""}
                </Tip>
              )}
            </Show>
            <Show
              when={TYPED.test(path())}
              fallback={
                <Tip as="span" class="language" tip="What the file is read as">
                  {language(path())}
                </Tip>
              }
            >
              <Tip
                as="a"
                class="language"
                href={`${DOCS}compatibility/toolchain/#type-checking`}
                target="_blank"
                rel="noopener"
                tip={
                  <>
                    Type-checked by tsrs {TSRS_VERSION}, a Rust port of TypeScript {TS_VERSION}
                    <span class="tooltip-note">Opens what it checks in the docs</span>
                  </>
                }
              >
                {language(path())} {TS_SHORT}
              </Tip>
            </Show>
          </>
        )}
      </Show>
      <Shortcuts placement="top" />
      <Tip
        as="a"
        href={`${DOCS}compatibility/bun/`}
        target="_blank"
        rel="noopener"
        placement="top-end"
        tip={
          <>
            The Bun release these crates are built from
            <span class="tooltip-note">Opens what works in the docs</span>
          </>
        }
      >
        Bun {BUN_VERSION}
      </Tip>
    </footer>
  );
}
