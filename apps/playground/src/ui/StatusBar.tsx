import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { installState, type InstallState } from "../installState";
import { onSaveState, type SaveState } from "../persist";
import { trackChanges } from "../changes";
import { DOCS } from "../base";
import { chordKeys, keysFor, type Command } from "../keymap";
import { TYPED } from "../typecheck";
import { TS_VERSION, TSRS_VERSION } from "../typecheck/tsrsLs";
import { BUN_VERSION } from "../worker/bunVersion";
import { AppContext } from "./context";
import { debugSession } from "../debugSession";
import { Feedback } from "./Feedback";
import { Tip } from "@runbun/ui/solid/Tip";
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@runbun/ui/solid/Menu";
import { HOSTING } from "../hosting";

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
  rx: "ReactiveScript",
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
      <Show when={debugSession.available()}>
        <Tip tip="Show or hide the debugger (runs pause at breakpoints while it's shown)" type="button" aria-pressed={debugSession.enabled() ? "true" : "false"} onClick={() => debugSession.setEnabled(!debugSession.enabled())}>
          <i class="i-lucide-bug" aria-hidden="true" />
          <span class="sr-only">Debugger</span>
        </Tip>
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
                <Tip as="span" class="language" tip="Language of the file">
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
                    <span class="tooltip-note">Opens the type-checking docs</span>
                  </>
                }
              >
                {language(path())} {TS_SHORT}
              </Tip>
            </Show>
          </>
        )}
      </Show>
      <Show when={app.features?.has("format") ?? true}>
        <Tip
          type="button"
          class="format-on-save"
          aria-pressed={ws.formatOnSave() ? "true" : "false"}
          keys={keys("save")}
          tip={ws.formatOnSave() ? "Format on save is on (bun fmt). Auto-saves skip it" : "Format on save is off. Click to turn it on"}
          onClick={() => ws.setFormatOnSave(!ws.formatOnSave())}
        >
          <i class="i-lucide-wand-sparkles" aria-hidden="true" />
          <span class="sr-only">Format on save</span>
        </Tip>
      </Show>
      <Install />
      <Saved />
      <Tip
        as="a"
        href={`${DOCS}compatibility/bun/`}
        target="_blank"
        rel="noopener"
        placement="top-end"
        tip={
          <>
            The Bun release this is built from
            <span class="tooltip-note">Opens the compatibility docs</span>
          </>
        }
      >
        Bun {BUN_VERSION}
      </Tip>
      {/* Feedback goes to runbun.dev's Worker (the hosting file's `worker`). */}
      <Show when={HOSTING.worker}>
        <Feedback />
      </Show>
      {/* The landing page, which a host can leave out (the hosting file's `landing`). */}
      <Show when={HOSTING.landing}>
        <Tip as="a" href={`${import.meta.env.BASE_URL}about`} target="_blank" rel="noopener" placement="top-end" tip="What runbun.dev is and how it runs Bun">
          About
        </Tip>
      </Show>
      {/* A branded host (the hosting file's `brand`) without the landing page: runbun.dev's, which says what it runs on. */}
      <Show when={HOSTING.brand && !HOSTING.landing}>
        <Tip as="a" href="https://runbun.dev/about" target="_blank" rel="noopener" placement="top-end" tip="Powered by runbun: Bun's toolchain in the browser">
          About
        </Tip>
      </Show>
      <Tip as="a" href={`${DOCS}privacy/`} target="_blank" rel="noopener" placement="top-end" tip="Privacy: no tracking, and what is stored">
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
    if (n === null) return props.git ? "Show or hide Git" : head ? "Show changes since the last commit" : "Show changes from the project's source";
    if (!n) return `${head ? "No changes since the last commit" : "No changes from the project's source"}. Click to ${action}`;
    const files = `${n} ${n === 1 ? "file" : "files"}`;
    return head ? `${files} changed since the last commit. Click to ${action}` : `${files} ${n === 1 ? "differs" : "differ"} from the project's source. Click to ${action}`;
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

/**
 * The ports the running program serves (`Bun.serve`, `http.Server#listen`), its child processes' too. With one, a
 * click shows the preview if it's hidden; with several, a click opens a menu of them that picks the one the preview shows.
 */
function Ports(props: { previewShown: boolean; showPreview(): void }) {
  const app = useContext(AppContext);
  const session = app.session;
  const shown = () => session.previewPort() ?? session.ports()[0];
  const pick = (port: number) => {
    if (port !== shown()) app.choosePort(port);
    if (!props.previewShown) props.showPreview();
  };
  const label = () => (
    <>
      <i class="i-lucide-radio" aria-hidden="true" />:{shown()}
      {session.ports().length > 1 ? ` +${session.ports().length - 1}` : ""}
    </>
  );
  return (
    <Show when={session.ports().length}>
      <Show
        when={session.ports().length > 1}
        fallback={
          <Tip
            type="button"
            class="ports"
            aria-disabled={props.previewShown ? "true" : undefined}
            tip={props.previewShown ? `Port ${shown()}, shown in the preview` : `Port ${shown()}. Click to show the preview.`}
            onClick={() => !props.previewShown && props.showPreview()}
          >
            {label()}
          </Tip>
        }
      >
        <Menu
          placement="top-start"
          trigger={
            <Tip as={MenuTrigger} class="ports" tip={`Ports ${session.ports().join(", ")}. Preview shows ${shown()}. Click to pick another`}>
              {label()}
            </Tip>
          }
        >
          <MenuGroup label="Show in the preview">
            <For each={session.ports()}>
              {(port) => (
                <MenuItem icon={port === shown() ? "i-lucide-check" : "i-lucide-check invisible"} label={`:${port}`} onSelect={() => pick(port)}>
                  <Show when={port === shown()}>
                    <span class="sr-only">(shown)</span>
                  </Show>
                </MenuItem>
              )}
            </For>
          </MenuGroup>
        </Menu>
      </Show>
    </Show>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listed = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));

/**
 * Whether the dependencies are installed (installState.ts). A click installs when some are missing (or again, when
 * they're all there, or bun.lock is behind package.json), and opens the file that doesn't parse. Nothing without dependencies.
 */
function Install() {
  const { vfs, session, workspace: ws, install } = useContext(AppContext);
  const [state, setState] = createSignal<InstallState>({ kind: "none" });
  onSettled(() => {
    setState(installState(vfs));
    // An install writes thousands of files: look again once a burst of changes is over.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = vfs.onChange(({ path }) => {
      if (path !== "package.json" && path !== "bun.lock" && !path.startsWith("node_modules/")) return;
      clearTimeout(timer);
      timer = setTimeout(() => setState(installState(vfs)), 200);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  });
  const busy = () => !!session.busy.install;
  const view = () => {
    const st = state();
    if (busy()) return { icon: "i-lucide-loader-circle spin", label: "Installing…", tip: "bun install is running" };
    switch (st.kind) {
      case "none":
        return undefined;
      case "missing":
        return { icon: "i-lucide-package-x", label: "Not installed", tip: `Missing: ${listed(st.names)}. Click to run bun install` };
      case "stale":
        return {
          icon: "i-lucide-package-minus",
          label: "bun.lock out of date",
          tip: `package.json changed ${listed(st.names)} since bun.lock. Click to run bun install`,
        };
      case "unreadable":
        return { icon: "i-lucide-package-x", label: `${st.file} unreadable`, tip: `${st.file} has a syntax error. Click to open` };
      case "installed":
        return {
          icon: "i-lucide-package-check",
          label: String(st.count),
          tip: `${plural(st.count, "dependency")} installed. Click to run bun install again`,
        };
    }
  };
  const click = () => {
    const st = state();
    if (busy()) return;
    if (st.kind === "unreadable") ws.open(st.file);
    else install();
  };
  return (
    <Show when={view()}>
      {(v) => (
        <Tip type="button" class="install" aria-disabled={busy() ? "true" : undefined} tip={v().tip} onClick={click}>
          <i class={v().icon} aria-hidden="true" />
          <span class="label">{v().label}</span>
          <span class="sr-only">dependencies</span>
        </Tip>
      )}
    </Show>
  );
}

/** Where edits go and whether they're there yet (persist.ts): this browser's storage, a folder on disk, or nowhere. */
function Saved() {
  const [state, setState] = createSignal<SaveState>({ where: "nowhere", pending: false });
  onSettled(() => onSaveState(setState));
  const view = () => {
    const st = state();
    if (st.failed) return { icon: "i-lucide-triangle-alert", label: "Not saved", tip: `Save failed: ${st.failed}. Retries on your next edit` };
    if (st.where === "nowhere") return { icon: "i-lucide-circle-slash", label: "Not saved", tip: `${st.why ?? "Edits aren't kept"}. Reloading loses them` };
    const place = st.where === "folder" ? `the folder ${st.name} on disk` : "this browser";
    if (st.pending) return { icon: "i-lucide-loader-circle spin", label: "Saving…", tip: `Saving to ${place}` };
    return { icon: st.where === "folder" ? "i-lucide-folder-check" : "i-lucide-check", label: "Saved", tip: `Saved to ${place}` };
  };
  return (
    <Tip as="span" class="saved" tip={view().tip}>
      <i class={view().icon} aria-hidden="true" />
      <span class="label">{view().label}</span>
    </Tip>
  );
}
