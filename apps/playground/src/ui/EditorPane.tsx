import { isLazy } from "@runbun/vfs";
import { Show, createEffect, onSettled, useContext } from "solid-js";
import { CHECKED, mountDiagnostics } from "../diagnostics";
import { createPierre } from "../editors/pierre";
import { chordKeys, keysFor, matches } from "../keymap";
import type { CodeEditor, EditorLocation } from "../editors/types";
import { asConsoleEntry, errorLocation, fmt } from "../fmt";
import { complete, definition, hover, resolveCompletion, signatureHelp, TYPED } from "../typecheck";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import type { Peek } from "./workspace";
import { EditorTabs } from "./Tabs";
import { Keys, Tip } from "@runbun/ui/solid/Tip";

/** How long auto-save waits after the last keystroke. */
const SAVE_DELAY = 300;
/** tsconfig.json, jsconfig.json and configs named like them (tsconfig.base.json, which another may `extends`). */
const CONFIG = /(?:^|\/)[jt]sconfig(?:\.[^/]*)?\.json$/;

/**
 * The open-file tabs over the editor, which shows the active tab and writes edits back to the VFS: shortly after
 * typing stops with auto-save on, else on the save shortcut (Ctrl/Cmd+S) (and before Run, Install or Share, through `ws.saveAll`).
 * Format (the format shortcut, Shift+Alt+F) runs `bun fmt` on the open file as one undoable edit.
 */
export function EditorPane() {
  const app = useContext(AppContext);
  const { vfs, workspace: ws, log } = app;
  // An embed loads the type checker (10 MB) and the formatter (7 MB) only once they're turned on.
  const has = (name: "types" | "format" | "tabs" | "autosave" | "edit") => app.features?.has(name) ?? true;
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  let check: ReturnType<typeof mountDiagnostics> | undefined;
  // The file the editor shows, as last applied; edits to any other file are stale.
  let current: string | null = null;
  // Edited text not in the VFS yet, per file. Switching tabs keeps it.
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Writes `path`'s edits to the VFS; false when there were none. */
  function save(path: string) {
    const text = pending.get(path);
    if (text === undefined) return false;
    pending.delete(path);
    vfs.write(path, text);
    ws.setDirty(path, false);
    return true;
  }
  function saveAll() {
    clearTimeout(timer);
    let any = false;
    for (const path of [...pending.keys()]) any = save(path) || any;
    return any;
  }
  ws.onSaveAll(saveAll);
  // Saving as you type again (the toggle back on, or an embed's switch turned off): edits waiting for Ctrl/Cmd+S save now.
  createEffect(
    () => ws.autosave() || !has("autosave"),
    (on) => {
      if (on && saveAll()) ws.markSaved();
    },
  );
  ws.onReveal((line, column) => editor?.reveal(line, column));
  // A definition in another file: where to put the cursor once its tab is open.
  let revealOnOpen: EditorLocation | undefined;

  /** Moves to where the name at `line`/`column` of `file` is declared, opening that file's tab if it's another. */
  async function goToDefinition(file: string, line: number, column: number) {
    if (!TYPED.test(file) || !editor || !has("types")) return;
    const [to] = await definition(vfs, file, editor.getText(), line, column);
    if (!to || file !== current) return;
    if (to.path === current) return editor.reveal(to.line, to.column);
    revealOnOpen = to;
    ws.open(to.path);
  }
  ws.onOpenAt((path, line, column) => {
    if (path === current) return editor?.reveal(line, column);
    revealOnOpen = { path, line, column };
    ws.open(path);
  });
  ws.onFormat(() => void formatOpenFile());

  async function formatOpenFile() {
    const path = current;
    if (!path || !editor || !has("format")) return;
    try {
      const r = await fmt(vfs, path, editor.getText());
      if (path !== current) return;
      if (r.exitCode === 0) return editor.replace(r.stdout);
      log("error", asConsoleEntry(r.stderr));
      // JS and TS errors are already marked as you type; mark where other files stop parsing, until the next edit.
      const at = errorLocation(r.stderr);
      if (at && !CHECKED.test(path)) editor.setDiagnostics([{ severity: "error", message: at.message, line: at.line, column: at.column, length: 0, source: "bun fmt" }]);
    } catch (e) {
      log("error", `[fmt] ${e}`);
    }
  }


  /** Loads a lazy file, then shows it if it's still the open file and unedited. */
  function showWhenLoaded(path: string) {
    void vfs.ensure([path]).then(() => {
      if (current !== path || pending.has(path)) return;
      const t = vfs.textOf(path);
      if (typeof t === "string") {
        editor?.update(t);
        check?.(path, t);
      }
    });
  }

  createEffect(
    () => ws.state.active,
    guarded("editor", (path) => {
      editor ??= createPierre(el, {
        readOnly: () => !has("edit"),
        onCursor: ws.setCursor,
        onDiagnostics: ws.setProblems,
        // Types for TypeScript files, with the editor's text (unsaved edits included).
        hover: async (file, line, column) => (TYPED.test(file) && editor && has("types") ? hover(vfs, file, editor.getText(), line, column) : null),
        complete: async (file, line, column, trigger) => (TYPED.test(file) && editor && has("types") ? complete(vfs, file, editor.getText(), line, column, trigger) : null),
        resolveCompletion: async (file, item) => (editor ? resolveCompletion(vfs, file, editor.getText(), item) : null),
        signatureHelp: async (file, line, column, trigger, retrigger) =>
          TYPED.test(file) && editor ? signatureHelp(vfs, file, editor.getText(), line, column, trigger, retrigger) : null,
        goToDefinition: (file, line, column) => void goToDefinition(file, line, column),
      });
      check ??= mountDiagnostics(vfs, editor, () => has("types"));
      current = path;
      if (!path) {
        editor.clear();
        check(null, null);
        return;
      }
      // A large installed file kept out of memory opens empty and fills in once loaded.
      const lazy = !pending.has(path) && isLazy(vfs.read(path));
      const text = pending.get(path) ?? (lazy ? "" : vfs.textOf(path)) ?? null;
      if (lazy) showWhenLoaded(path);
      editor.open(path, text, (next) => {
        if (current !== path) return;
        pending.set(path, next);
        ws.setDirty(path, true);
        check!(path, next);
        clearTimeout(timer);
        if (ws.autosave() || !has("autosave")) timer = setTimeout(() => saveAll() && ws.markSaved(), SAVE_DELAY);
      });
      check(path, text);
      if (revealOnOpen?.path === path) editor.reveal(revealOnOpen.line, revealOnOpen.column);
      revealOnOpen = undefined;
    }),
  );

  // Errors found while packages were still installing (a shared link checks before its install ends) are stale after it.
  createEffect(
    () => !!app.session.busy.install,
    (installing) => {
      if (!installing && current && editor) check?.(current, editor.getText());
    },
  );

  onSettled(() => {
    // The open file changed outside the editor (e.g. `Bun.write`); unsaved edits win over that.
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (removed && pending.delete(path)) ws.setDirty(path, false);
      // A tsconfig.json/jsconfig.json (or a config one extends) changes how the open file transpiles and type-checks.
      if (current && editor && path !== current && CONFIG.test(path)) return check?.(current, editor.getText());
      if (created || removed || path !== current || pending.has(path)) return;
      if (isLazy(vfs.read(path))) return showWhenLoaded(path);
      const d = vfs.textOf(path);
      if (typeof d === "string") {
        editor?.update(d);
        check?.(path, d);
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (matches("goToDefinition", e)) {
        e.preventDefault();
        const at = ws.cursor();
        if (current && at) void goToDefinition(current, at.line, at.column);
        return;
      }
      if (matches("showHover", e)) {
        e.preventDefault();
        editor?.showHover();
        return;
      }
      if (matches("suggest", e)) {
        e.preventDefault();
        editor?.suggest();
        return;
      }
      if (matches("signatureHelp", e)) {
        e.preventDefault();
        editor?.showSignatureHelp();
        return;
      }
      // The request body formats itself (Preview.tsx) and says so with preventDefault.
      if (matches("format", e) && !e.defaultPrevented) {
        e.preventDefault();
        void formatOpenFile();
        return;
      }
      if (!matches("save", e)) return;
      e.preventDefault();
      if (current && save(current)) ws.markSaved();
    };
    // Pending auto-saves go to the VFS before the page goes (persistence writes on pagehide); with auto-save off,
    // unsaved edits make the browser ask first, as editors do.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!pending.size) return;
      if (ws.autosave() || !has("autosave")) saveAll();
      else e.preventDefault();
    };
    addEventListener("keydown", onKey);
    addEventListener("beforeunload", onUnload);
    return () => {
      unsubscribe();
      removeEventListener("keydown", onKey);
      removeEventListener("beforeunload", onUnload);
      clearTimeout(timer);
      editor?.destroy();
    };
  });

  return (
    <>
      {/* An embed shows the tabs bar only with its tabs or its Auto-save toggle (`autosave`). */}
      <Show when={has("tabs") || app.features?.has("autosave")}>
        <div class="tabs-bar">
          <Show when={has("tabs")}>
            <EditorTabs />
          </Show>
          {/* The full playground's Auto-save and Watch are in the header. */}
          <Show when={app.features?.has("autosave")}>
            <Tip
              class="autosave"
              type="button"
              aria-pressed={ws.autosave() ? "true" : "false"}
              tip={<AutosaveTip on={ws.autosave()} />}
              onClick={() => {
                ws.setAutosave(!ws.autosave());
              }}
            >
              <i class={ws.autosave() ? "i-lucide-save" : "i-lucide-save-off"} aria-hidden="true" /> Auto-save
            </Tip>
          </Show>
        </div>
      </Show>
      {/* "No file open" only once the project has loaded, not while its first file is on the way. */}
      <div class="code-area">
        <div id="editor" ref={el} data-empty={app.session.ready() && !ws.state.active ? "" : undefined} />
        {/* Over the code's top right corner, shown while the pointer is over the code (always on touch screens). */}
        <Show when={has("format") && ws.state.active}>
          <Tip class="format" type="button" tip="Format the open file with bun fmt" keys={keysFor("format").map(chordKeys)} onClick={() => void formatOpenFile()}>
            <i class="i-lucide-wand-sparkles" aria-hidden="true" /> Format
          </Tip>
        </Show>
        {/* The example the project picker is on, over the open file until the menu closes. */}
        <Show when={ws.peek()} keyed>
          {(peek) => <PeekView peek={peek} />}
        </Show>
      </div>
    </>
  );
}

/** An example's entry file, highlighted and read-only (the file tree shows the rest of its files). */
function PeekView(props: { peek: Peek }) {
  let el!: HTMLDivElement;
  onSettled(() => {
    const view = createPierre(el, { readOnly: () => true });
    view.open(props.peek.path, props.peek.text, () => {});
    return () => view.destroy();
  });
  return (
    <div class="peek" aria-live="polite">
      <div class="peek-head">
        <span class="title">
          <i class="i-lucide-eye" aria-hidden="true" /> {props.peek.title}: pick it to load and run
        </span>
        <span class="path">{props.peek.path}</span>
      </div>
      <div class="peek-code" ref={el} />
    </div>
  );
}

/** What Auto-save does, on or off, for its toggle's tooltip (here in an embed, in the header otherwise). */
export function AutosaveTip(props: { on: boolean }) {
  const save = () => <Keys keys={keysFor("save").map(chordKeys)} />;
  return props.on ? (
    <span>Edits save shortly after you stop typing. Click to save with {save()} instead.</span>
  ) : (
    <span>Edits save with {save()} (and before Run). Click to save as you type.</span>
  );
}
