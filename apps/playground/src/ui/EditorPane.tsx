import { Show, createEffect, onSettled, useContext } from "solid-js";
import { CHECKED, mountDiagnostics } from "../diagnostics";
import { createPierre } from "../editors/pierre";
import { formatChord, keysFor, matches } from "../keymap";
import type { CodeEditor } from "../editors/types";
import { asConsoleEntry, errorLocation, fmt } from "../fmt";
import { complete, hover, resolveCompletion, signatureHelp, TYPED } from "../typecheck";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import { EditorTabs } from "./Tabs";
import { Tip } from "./Tip";

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
      });
      check ??= mountDiagnostics(vfs, editor, () => has("types"));
      current = path;
      if (!path) {
        editor.clear();
        check(null, null);
        return;
      }
      const data = vfs.read(path);
      const text = pending.get(path) ?? (typeof data === "string" ? data : null);
      editor.open(path, text, (next) => {
        if (current !== path) return;
        pending.set(path, next);
        ws.setDirty(path, true);
        check!(path, next);
        clearTimeout(timer);
        if (ws.autosave() || !has("autosave")) timer = setTimeout(() => saveAll() && ws.markSaved(), SAVE_DELAY);
      });
      check(path, text);
    }),
  );

  onSettled(() => {
    // The open file changed outside the editor (e.g. `Bun.write`); unsaved edits win over that.
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (removed && pending.delete(path)) ws.setDirty(path, false);
      // A tsconfig.json/jsconfig.json (or a config one extends) changes how the open file transpiles and type-checks.
      if (current && editor && path !== current && CONFIG.test(path)) return check?.(current, editor.getText());
      if (created || removed || path !== current || pending.has(path)) return;
      const d = vfs.read(path);
      if (typeof d === "string") {
        editor?.update(d);
        check?.(path, d);
      }
    });
    const onKey = (e: KeyboardEvent) => {
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
      if (matches("format", e)) {
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
      {/* An embed shows the tabs bar only with its tabs or the Auto-save toggle (`autosave`); without tabs, Format is in the embed's menu. */}
      <Show when={has("tabs") || has("autosave")}>
        <div class="tabs-bar">
          <Show when={has("tabs")}>
            <EditorTabs />
          </Show>
          <Show when={has("tabs") && has("format")}>
            <Tip class="format" type="button" disabled={!ws.state.active} tip="Format the open file with bun fmt" keys={keysFor("format").map(formatChord)} onClick={() => void formatOpenFile()}>
              <i class="i-lucide-wand-sparkles" aria-hidden="true" /> Format
            </Tip>
          </Show>
          <Show when={has("autosave")}>
            <Tip
              class="autosave"
              type="button"
              aria-pressed={ws.autosave() ? "true" : "false"}
              tip={ws.autosave() ? "Edits save shortly after you stop typing. Click to save with Ctrl/Cmd+S instead." : "Edits save with Ctrl/Cmd+S (and before Run). Click to save as you type."}
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
      <div id="editor" ref={el} data-empty={app.session.ready() && !ws.state.active ? "" : undefined} />
    </>
  );
}
