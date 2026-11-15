import { isLazy } from "@runbun/vfs";
import { Show, createEffect, onSettled, useContext } from "solid-js";
import { CHECKED, mountDiagnostics } from "../diagnostics";
import { JSON_FILE, connectJsonFiles, jsonComplete, jsonHover } from "../jsonLanguage";
import { isLspItem, lspCompletionDetails } from "../lspItems";
import { createPierre } from "../editors/pierre";
import { chordKeys, keysFor, matches } from "../keymap";
import type { CodeEditor, EditorLocation } from "../editors/types";
import { asConsoleEntry, errorLocation, fmt } from "../fmt";
import { complete, definition, hover, readTypes, resolveCompletion, signatureHelp, TYPED } from "../typecheck";
import { debugSession } from "../debugSession";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import { EditorTabs } from "./Tabs";
import { ChangesView } from "./Changes";
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
  /** A project file the type checker answers for (a read-only declaration tab isn't one: it's not in the project). */
  const typed = (file: string) => TYPED.test(file) && has("types") && ws.readOnlyText(file) === undefined;
  // Schema hints for .json files (runbun.json, or one naming its $schema), with type hints.
  const json = (file: string) => JSON_FILE.test(file) && has("types") && ws.readOnlyText(file) === undefined;

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
    if (!typed(file) || !editor) return;
    const [to] = await definition(vfs, file, editor.getText(), line, column);
    if (!to || file !== current) return;
    if (to.path === current) return editor.reveal(to.line, to.column);
    revealOnOpen = to;
    if (!to.readOnly) return ws.open(to.path);
    // TypeScript's lib files and Bun's bundled types aren't project files: they open read-only.
    const text = ws.readOnlyText(to.path) ?? (await readTypes(to.path));
    if (text === null) return void (revealOnOpen = undefined);
    if (file === current) ws.openReadOnly(to.path, text);
  }
  ws.onOpenAt((path, line, column) => {
    if (path === current) return editor?.reveal(line, column);
    revealOnOpen = { path, line, column };
    ws.open(path);
  });
  ws.onFormat(() => void formatOpenFile());

  /** `quiet` (format on save): a file `bun fmt` can't format, or one that doesn't parse, saves as it is, unremarked. */
  async function formatOpenFile(quiet = false) {
    const path = current;
    if (!path || !editor || !has("format") || ws.readOnlyText(path) !== undefined || ws.isReadonly(path)) return;
    try {
      const r = await fmt(vfs, path, editor.getText());
      if (path !== current) return;
      if (r.exitCode === 0) return editor.replace(r.stdout);
      if (quiet) return;
      log("error", asConsoleEntry(r.stderr));
      // JS and TS errors are already marked as you type; mark where other files stop parsing, until the next edit.
      const at = errorLocation(r.stderr);
      if (at && !CHECKED.test(path)) editor.setDiagnostics([{ severity: "error", message: at.message, line: at.line, column: at.column, length: 0, source: "bun fmt" }]);
    } catch (e) {
      if (!quiet) log("error", `[fmt] ${e}`);
    }
  }

  /** Ctrl/Cmd+S: formats the open file first with format on save on, then writes it. */
  async function saveOpenFile() {
    const path = current;
    if (!path) return;
    if (ws.formatOnSave() && has("format")) {
      await formatOpenFile(true);
      if (path !== current || !editor) return;
      // What the formatter wrote is what gets saved, whether or not the editor has reported the edit yet.
      const text = editor.getText();
      if (text !== (pending.get(path) ?? vfs.textOf(path))) pending.set(path, text);
    }
    if (save(path)) ws.markSaved();
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
        readOnly: () => !has("edit") || (current !== null && (ws.readOnlyText(current) !== undefined || ws.isReadonly(current))),
        onCursor: ws.setCursor,
        onDiagnostics: ws.setProblems,
        // Types for TypeScript files, with the editor's text (unsaved edits included).
        hover: async (file, line, column) =>
          !editor ? null : typed(file) ? hover(vfs, file, editor.getText(), line, column) : json(file) ? jsonHover(file, editor.getText(), line, column) : null,
        complete: async (file, line, column, trigger) =>
          !editor
            ? null
            : typed(file)
              ? complete(vfs, file, editor.getText(), line, column, trigger)
              : json(file)
                ? jsonComplete(file, editor.getText(), line, column)
                : null,
        resolveCompletion: async (file, item) => (!editor ? null : isLspItem(item) ? lspCompletionDetails(item) : resolveCompletion(vfs, file, editor.getText(), item)),
        signatureHelp: async (file, line, column, trigger, retrigger) =>
          typed(file) && editor ? signatureHelp(vfs, file, editor.getText(), line, column, trigger, retrigger) : null,
        goToDefinition: (file, line, column) => void goToDefinition(file, line, column),
        // Only while Debug is on, so line numbers stay plain otherwise.
        onGutterClick: (file, line) => debugSession.enabled() && ws.readOnlyText(file) === undefined && debugSession.toggleBreakpoint(file, line - 1),
      });
      check ??= mountDiagnostics(vfs, editor, () => has("types"));
      current = path;
      if (!path) {
        editor.clear();
        check(null, null);
        return;
      }
      const declarations = ws.readOnlyText(path);
      if (declarations !== undefined) {
        editor.open(path, declarations, () => {});
        check(null, null);
        ws.setCursor(null);
        if (revealOnOpen?.path === path) editor.reveal(revealOnOpen.line, revealOnOpen.column);
        revealOnOpen = undefined;
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

  // Breakpoint dots and the paused line follow the debugger's state and the open file. The paused file opens first
  // (its tab, then this effect again once the editor shows it).
  createEffect(
    () => [ws.state.active, debugSession.breakpoints(), debugSession.paused()] as const,
    guarded("debug-lines", ([path, breakpoints, paused]) => {
      if (!path || !editor || path !== current) return;
      editor.setDebugLines(
        (breakpoints[path] ?? []).map((l) => l + 1),
        paused?.path === path ? paused.line + 1 : null,
      );
    }),
  );
  createEffect(
    () => debugSession.paused(),
    (paused) => {
      if (paused) ws.openAt(paused.path, paused.line + 1, paused.column + 1);
    },
  );

  // Errors found while packages were still installing (a shared link checks before its install ends) are stale after it.
  createEffect(
    () => !!app.session.busy.install,
    (installing) => {
      if (!installing && current && editor) check?.(current, editor.getText());
    },
  );

  // A .json file's relative `$schema` (and its `$ref`s) is read from the project (jsonLanguage.ts).
  onSettled(() => connectJsonFiles(vfs));

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
    // A renamed file keeps its undo history under the new path.
    const unrename = ws.onRename((from, to) => editor?.rename(from, to));
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
      void saveOpenFile();
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
      unrename();
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
        <div id="editor" ref={el} hidden={ws.state.changesShown} data-empty={app.session.ready() && !ws.state.active ? "" : undefined} />
        {/* Kept while its tab is open (scroll position, rendered diffs), hidden behind a file tab. */}
        <Show when={ws.state.changes}>
          <ChangesView shown={ws.state.changesShown} />
        </Show>
        {/* Over the code's top right corner, shown while the pointer is over the code (always on touch screens). */}
        <Show when={has("format") && ws.state.active && !ws.state.changesShown && ws.readOnlyText(ws.state.active!) === undefined && !ws.isReadonly(ws.state.active!)}>
          <Tip class="format" type="button" tip="Format the open file with bun fmt" keys={keysFor("format").map(chordKeys)} onClick={() => void formatOpenFile()}>
            <i class="i-lucide-wand-sparkles" aria-hidden="true" /> Format
          </Tip>
        </Show>
      </div>
    </>
  );
}

/** What Auto-save does, on or off, for its toggle's tooltip (here in an embed, in the header otherwise). */
export function AutosaveTip(props: { on: boolean }) {
  const save = () => <Keys keys={keysFor("save").map(chordKeys)} />;
  return props.on ? (
    <span>Saving as you type. Click to save with {save()} only.</span>
  ) : (
    <span>Saving with {save()} and on Run. Click to save as you type.</span>
  );
}
