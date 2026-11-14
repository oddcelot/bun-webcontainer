import { createSignal, createStore } from "solid-js";
import type { Panel, Sized } from "../projectConfig";
import type { EditorCursor, EditorDiagnostic } from "../editors/types";
import { pref } from "../prefs";
import { EMBEDDED } from "../theme";

const AUTOSAVE_KEY = "runbun:autosave";
const WATCH_KEY = "runbun:watch";
const FORMAT_ON_SAVE_KEY = "runbun:format-on-save";

/**
 * Which files are open in tabs, which one is active, and which have edits not yet written to the VFS. Writes go
 * through the functions below; the UI reads `state`. Closing the active tab activates a neighbor.
 */
export function createWorkspace() {
  const [state, setState] = createStore({
    open: [] as string[],
    active: null as string | null,
    treeVersion: 0,
    /** Files whose editor text isn't in the VFS yet (auto-save pending, or auto-save off). */
    dirty: [] as string[],
    /** The Changes tab is open (after the file tabs), and shown instead of the active file. */
    changes: false,
    changesShown: false,
    /** The file the Changes tab scrolls to (`n` counts the requests, so asking again for the same file scrolls again). */
    changesFocus: { path: "", n: 0 },
  });
  /** Save edits shortly after typing stops; off, they wait for Ctrl/Cmd+S, Run, Install or Share. Shared by all tabs. */
  // An embed keeps it in memory: it shares runbun.dev's storage (see theme.ts).
  const [autosave, setAutosave] = EMBEDDED
    ? createSignal(true)
    : pref(AUTOSAVE_KEY, true, { serialize: (on) => (on ? "on" : "off"), deserialize: (s) => s !== "off" });
  /** Restart the program when an edit is saved (boot.ts); the full playground's toggle (an embed has its `watch` feature). */
  const [watch, setWatch] = EMBEDDED
    ? createSignal(true)
    : pref(WATCH_KEY, true, { serialize: (on) => (on ? "on" : "off"), deserialize: (s) => s !== "off" });
  /** Ctrl/Cmd+S formats the file with `bun fmt` before saving it (saves as you type don't: they'd move text under the cursor). */
  const [formatOnSave, setFormatOnSave] = EMBEDDED
    ? createSignal(false)
    : pref(FORMAT_ON_SAVE_KEY, false, { serialize: (on) => (on ? "on" : "off"), deserialize: (s) => s === "on" });
  const saved = new Set<() => void>();
  // Read-only declaration files a definition opened (TypeScript's libs, Bun's bundled types), by their checker path:
  // not the VFS's, which has no leading "/" or scheme. Kept out of the store: lib.dom.d.ts is megabytes.
  const readOnly = new Map<string, string>();
  // The open project's runbun.json `panels` (App.tsx shows and hides them); null: the reader's own layout.
  const [panels, setPanels] = createSignal<Partial<Record<Panel, boolean>> | null>(null);
  // Its `sizes`, in percent (App.tsx sizes the panes by them); null: the reader's own.
  const [sizes, setSizes] = createSignal<Partial<Record<Sized, number>> | null>(null);
  // What the editor reports for the status bar.
  const [cursor, setCursor] = createSignal<EditorCursor | null>(null);
  const [problems, setProblems] = createSignal<EditorDiagnostic[]>([]);
  // The editor's pending edits; it registers how to write them (see EditorPane).
  let saveAll = () => {};
  let reveal: (line: number, column: number) => void = () => {};
  let openAt: (path: string, line: number, column: number) => void = () => {};
  let format = () => {};
  const renamed = new Set<(from: string, to: string) => void>();
  // Files an embedding page owns (embed `generated`): in the project, never in the tree or a tab.
  const generated = new Set<string>();
  return {
    state,
    setDirty(path: string, dirty: boolean) {
      setState((s) => {
        const i = s.dirty.indexOf(path);
        if (dirty && i < 0) s.dirty.push(path);
        else if (!dirty && i >= 0) s.dirty.splice(i, 1);
      });
    },
    autosave,
    setAutosave,
    watch,
    setWatch,
    formatOnSave,
    setFormatOnSave,
    /** Calls `fn` after each save the reader made (as they type, or Ctrl/Cmd+S), not those before Run; returns the unsubscribe. */
    onSaved(fn: () => void) {
      saved.add(fn);
      return () => void saved.delete(fn);
    },
    markSaved() {
      for (const fn of saved) fn();
    },
    onSaveAll(fn: () => void) {
      saveAll = fn;
    },
    /** The open file's cursor, null with no editable file open. */
    cursor,
    setCursor,
    /** The panes the open project asks for (runbun.json), applied over the reader's layout without saving it. */
    panels,
    setPanels,
    /** The panes' shares of space the open project asks for (runbun.json `sizes`), likewise not saved. */
    sizes,
    setSizes,
    /** The open file's error and warning markers. */
    problems,
    setProblems,
    onReveal(fn: typeof reveal) {
      reveal = fn;
    },
    /** Moves the editor's cursor to a 1-based line and column of the open file. */
    reveal: (line: number, column: number) => reveal(line, column),
    onOpenAt(fn: typeof openAt) {
      openAt = fn;
    },
    /** Opens `path` (or switches to its tab) with the cursor at a 1-based line and column. */
    openAt: (path: string, line: number, column: number) => void (!generated.has(path) && openAt(path, line, column)),
    onFormat(fn: () => void) {
      format = fn;
    },
    /** Formats the open file (`bun fmt`), as the Format button does. */
    format: () => format(),
    /** Writes every pending edit to the VFS now (before running, installing or sharing). */
    saveAll: () => saveAll(),
    /** Opens a read-only declaration file (see `readOnly`) in a tab, or switches to its tab. */
    openReadOnly(path: string, text: string) {
      readOnly.set(path, text);
      this.open(path);
    },
    /** The text of a read-only tab's file, or undefined for a project file. */
    readOnlyText: (path: string) => readOnly.get(path),
    /**
     * Keeps these files out of the file tree and the tabs, in place of the last ones (set before the tree mounts, or
     * before `reloadTree`; `open` ignores them). None once a library project opens.
     */
    setGenerated(paths: string[]) {
      generated.clear();
      for (const p of paths) generated.add(p);
    },
    isGenerated: (path: string) => generated.has(path),
    /** Opens `path` in a tab (after the active one) or switches to its tab. */
    open(path: string) {
      if (generated.has(path)) return;
      setState((s) => {
        if (!s.open.includes(path)) s.open.splice(s.active ? s.open.indexOf(s.active) + 1 : s.open.length, 0, path);
        s.active = path;
        s.changesShown = false;
      });
    },
    activate(path: string) {
      setState((s) => {
        s.active = path;
        s.changesShown = false;
      });
    },
    /** Opens the Changes tab (what differs from the project's source) or switches to it. */
    showChanges() {
      setState((s) => {
        s.changes = true;
        s.changesShown = true;
      });
    },
    /** Opens the Changes tab scrolled to one file's diff. */
    showChange(path: string) {
      setState((s) => {
        s.changes = true;
        s.changesShown = true;
        s.changesFocus = { path, n: s.changesFocus.n + 1 };
      });
    },
    closeChanges() {
      setState((s) => {
        s.changes = false;
        s.changesShown = false;
      });
    },
    close(path: string) {
      setState((s) => {
        const i = s.open.indexOf(path);
        if (i < 0) return;
        s.open.splice(i, 1);
        if (s.active === path) s.active = s.open[i] ?? s.open[i - 1] ?? null;
      });
      readOnly.delete(path);
    },
    /** Calls `fn` when a file or folder is renamed (before the tabs follow it); returns the unsubscribe. */
    onRename(fn: (from: string, to: string) => void) {
      renamed.add(fn);
      return () => void renamed.delete(fn);
    },
    /** Points the tabs (and their unsaved marks) at a file's or folder's new path, keeping their order and the active one. */
    rename(from: string, to: string) {
      for (const fn of renamed) fn(from, to);
      const a = from.replace(/\/$/, "");
      const b = to.replace(/\/$/, "");
      const move = (p: string) => (p === a ? b : p.startsWith(`${a}/`) ? b + p.slice(a.length) : p);
      setState((s) => {
        s.open = s.open.map(move);
        s.dirty = s.dirty.map(move);
        if (s.active) s.active = move(s.active);
      });
    },
    closeAll() {
      setState((s) => {
        s.open = [];
        s.active = null;
      });
      readOnly.clear();
    },
    /** The file tree re-reads every path from the VFS (after it was cleared and refilled). */
    reloadTree() {
      setState((s) => {
        s.treeVersion++;
      });
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
