import { createEffect, onSettled, useContext } from "solid-js";
import { CHECKED, mountDiagnostics } from "../diagnostics";
import { createPierre } from "../editors/pierre";
import { formatChord, keysFor, matches } from "../keymap";
import type { CodeEditor } from "../editors/types";
import { asConsoleEntry, errorLocation, fmt } from "../fmt";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import { EditorTabs } from "./Tabs";

/** How long auto-save waits after the last keystroke. */
const SAVE_DELAY = 300;

/**
 * The open-file tabs over the editor, which shows the active tab and writes edits back to the VFS: shortly after
 * typing stops with auto-save on, else on the save shortcut (Ctrl/Cmd+S) (and before Run, Install or Share, through `ws.saveAll`).
 * Format (the format shortcut, Shift+Alt+F) runs `bun fmt` on the open file as one undoable edit.
 */
export function EditorPane() {
  const { vfs, workspace: ws, session, log } = useContext(AppContext);
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  let check: ReturnType<typeof mountDiagnostics> | undefined;
  // The file the editor shows, as last applied; edits to any other file are stale.
  let current: string | null = null;
  // Edited text not in the VFS yet, per file. Switching tabs keeps it.
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function save(path: string) {
    const text = pending.get(path);
    if (text === undefined) return;
    pending.delete(path);
    vfs.write(path, text);
    ws.setDirty(path, false);
  }
  function saveAll() {
    clearTimeout(timer);
    for (const path of [...pending.keys()]) save(path);
  }
  ws.onSaveAll(saveAll);

  async function formatOpenFile() {
    const path = current;
    if (!path || !editor) return;
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
      editor ??= createPierre(el);
      check ??= mountDiagnostics(vfs, editor);
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
        if (ws.autosave()) timer = setTimeout(saveAll, SAVE_DELAY);
      });
      check(path, text);
    }),
  );

  onSettled(() => {
    // The open file changed outside the editor (e.g. `Bun.write`); unsaved edits win over that.
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (removed && pending.delete(path)) ws.setDirty(path, false);
      if (created || removed || path !== current || pending.has(path)) return;
      const d = vfs.read(path);
      if (typeof d === "string") {
        editor?.update(d);
        check?.(path, d);
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (matches("format", e)) {
        e.preventDefault();
        void formatOpenFile();
        return;
      }
      if (!matches("save", e)) return;
      e.preventDefault();
      if (current) save(current);
    };
    // Pending auto-saves go to the VFS before the page goes (persistence writes on pagehide); with auto-save off,
    // unsaved edits make the browser ask first, as editors do.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!pending.size) return;
      if (ws.autosave()) saveAll();
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
      <div class="tabs-bar">
        <EditorTabs placeholder={!session.ready() && !ws.state.open.length} />
        <button class="format" type="button" disabled={!ws.state.active} title={["Format the open file with bun fmt", ...keysFor("format").map(formatChord)].join(" · ")} onClick={() => void formatOpenFile()}>
          <i class="i-lucide-wand-sparkles" aria-hidden="true" /> Format
        </button>
        <button
          class="autosave"
          type="button"
          aria-pressed={ws.autosave() ? "true" : "false"}
          title={ws.autosave() ? "Edits save shortly after you stop typing. Click to save with Ctrl/Cmd+S instead." : "Edits save with Ctrl/Cmd+S (and before Run). Click to save as you type."}
          onClick={() => {
            const on = !ws.autosave();
            ws.setAutosave(on);
            if (on) saveAll();
          }}
        >
          <i class={ws.autosave() ? "i-lucide-save" : "i-lucide-save-off"} aria-hidden="true" /> Auto-save
        </button>
      </div>
      {/* "No file open" only once the project has loaded, not while its first file is on the way. */}
      <div id="editor" ref={el} data-empty={session.ready() && !ws.state.active ? "" : undefined} />
    </>
  );
}
