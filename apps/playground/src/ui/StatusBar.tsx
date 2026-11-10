import { Show, createSignal, onSettled, useContext } from "solid-js";
import { trackChanges } from "../changes";
import { DOCS } from "../base";
import { chordKeys, keysFor, type Command } from "../keymap";
import { TYPED } from "../typecheck";
import { TS_VERSION, TSRS_VERSION } from "../typecheck/tsrsLs";
import { BUN_VERSION } from "../worker/bunVersion";
import { pref } from "../prefs";
import { AppContext } from "./context";
import { Feedback } from "./Feedback";
import { StatusPill } from "./Status";
import { Tip } from "@runbun/ui/solid/Tip";

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

const keys = (command: Command) => keysFor(command).map(chordKeys);

/** Where the run status shows: a pill in this bar, or a toast over the panes (App.tsx); picked under Appearance. */
export const [statusDisplay, setStatusDisplay] = pref<"bar" | "toast">("runbun:status", "bar", { serialize: (v) => v, deserialize: (s) => (s === "toast" ? "toast" : "bar") });

/**
 * The bar along the bottom, as in VS Code or Zed: panel toggles and the program's status on the left, the open
 * file's problems, cursor and language, the Bun release, Feedback and the privacy link on the right.
 */
export function StatusBar(props: { treeShown: boolean; toggleFiles(): void; toggleGit(): void; previewShown: boolean; consoleShown: boolean; toggle(i: number): void }) {
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

  // The explorer pane shows the files or Git; with git off (an embed's feature), just the files.
  const gitOn = () => app.features?.has("git") ?? true;
  const shows = (view: "files" | "git") => props.treeShown && (gitOn() ? app.git.state.view : "files") === view;

  return (
    <footer id="statusbar">
      <Tip tip="Show or hide the file tree" keys={keys("toggleExplorer")} type="button" aria-pressed={shows("files") ? "true" : "false"} onClick={props.toggleFiles}>
        <i class="i-lucide-panel-left" aria-hidden="true" />
        <span class="sr-only">File tree</span>
      </Tip>
      <Tip tip="Show or hide the preview" keys={keys("togglePreview")} type="button" aria-pressed={props.previewShown ? "true" : "false"} onClick={() => props.toggle(0)}>
        <i class="i-lucide-app-window" aria-hidden="true" />
        <span class="sr-only">Preview</span>
      </Tip>
      <Tip tip="Show or hide the console" keys={keys("toggleConsole")} type="button" aria-pressed={props.consoleShown ? "true" : "false"} onClick={() => props.toggle(1)}>
        <i class="i-lucide-square-terminal" aria-hidden="true" />
        <span class="sr-only">Console</span>
      </Tip>
      <Show when={statusDisplay() === "bar"}>
        <StatusPill role="status" status={s.status()} title={s.status().text} />
      </Show>
      <Ports previewShown={props.previewShown} showPreview={() => props.toggle(0)} />
      <span class="spacer" />
      <Changed git={gitOn()} gitShown={shows("git")} toggleGit={props.toggleGit} />
      <Show when={!ws.state.changesShown && ws.state.active}>
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
      <Feedback />
      <Tip as="a" href={`${import.meta.env.BASE_URL}about`} target="_blank" rel="noopener" placement="top-end" tip="What runbun.dev is and how it runs Bun">
        About
      </Tip>
      <Tip as="a" href={`${DOCS}privacy/`} target="_blank" rel="noopener" placement="top-end" tip="No tracking; cookies only if you sign in with GitHub; what is stored, and where">
        Privacy
      </Tip>
    </footer>
  );
}

/** How many files differ from the project's source; opens the Changes tab. No count until a repo's source is fetched. */
function Changed(props: { git: boolean; gitShown: boolean; toggleGit(): void }) {
  const { vfs, workspace: ws, git } = useContext(AppContext);
  const [count, setCount] = createSignal<number | null>(null);
  onSettled(() => trackChanges(vfs, (list) => setCount(list?.length ?? null), false));
  // With a commit in the repository the files are compared with it (git/store.ts), not with where the project came from.
  // With git on, a click shows or hides the Git view (whose Changes header opens the Changes tab); off, it opens the tab.
  const tip = () => {
    const n = count();
    const head = git.state.hasHead;
    const action = props.git ? "show or hide Git" : "show the changes";
    if (n === null) return props.git ? "Show or hide Git: changes, commits and branches" : head ? "Compare the files with the last commit" : "Compare the files with the project's source";
    if (!n) return `${head ? "No changes since the last commit" : "No changes from the project's source"}: ${action}`;
    const files = `${n} ${n === 1 ? "file" : "files"}`;
    return head ? `${files} changed since the last commit: ${action}` : `${files} ${n === 1 ? "differs" : "differ"} from the project's source: ${action}`;
  };
  return (
    <Tip
      tip={tip()}
      keys={props.git ? keys("toggleGit") : undefined}
      type="button"
      class="changed"
      aria-pressed={(props.git ? props.gitShown : ws.state.changesShown) ? "true" : "false"}
      onClick={() => (props.git ? props.toggleGit() : ws.showChanges())}
    >
      <i class="i-lucide-git-compare" aria-hidden="true" /> {count() ?? ""}
      <span class="sr-only">{props.git ? "Git" : "Changes"}</span>
    </Tip>
  );
}

/** The ports the running program serves (`Bun.serve`, `http.Server#listen`); a click shows the preview if it's hidden. */
function Ports(props: { previewShown: boolean; showPreview(): void }) {
  const { session } = useContext(AppContext);
  const tip = () => {
    const [first, ...rest] = session.ports();
    const serving = rest.length ? `Serving on ports ${[first, ...rest].join(", ")}; the preview shows ${first}` : `Serving on port ${first}; the preview shows it`;
    return props.previewShown ? serving : `${serving}. Click to show the preview.`;
  };
  return (
    <Show when={session.ports().length}>
      <Tip type="button" class="ports" aria-disabled={props.previewShown ? "true" : undefined} tip={tip()} onClick={() => !props.previewShown && props.showPreview()}>
        <i class="i-lucide-radio" aria-hidden="true" />:{session.ports()[0]}
        {session.ports().length > 1 ? ` +${session.ports().length - 1}` : ""}
      </Tip>
    </Show>
  );
}
