import { createSignal, createStore } from "solid-js";
import type { EditorCursor, EditorDiagnostic } from "../editors/types";
import { pref } from "../prefs";
import { EMBEDDED } from "../theme";

const AUTOSAVE_KEY = "runbun:autosave";
const WATCH_KEY = "runbun:watch";

/** A look at a project's files without opening it: its name, its files, and the one to show (its entry). */
export type Peek = { title: string; files: Map<string, string>; path: string };

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
  const saved = new Set<() => void>();
  // What the editor reports for the status bar.
  const [cursor, setCursor] = createSignal<EditorCursor | null>(null);
  const [problems, setProblems] = createSignal<EditorDiagnostic[]>([]);
  // An example the project picker points at: shown read-only over the editor, never loaded or run.
  const [peek, setPeek] = createSignal<Peek | null>(null);
  // The editor's pending edits; it registers how to write them (see EditorPane).
  let saveAll = () => {};
  let reveal: (line: number, column: number) => void = () => {};
  let openAt: (path: string, line: number, column: number) => void = () => {};
  let format = () => {};
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
    /** The open file's error and warning markers. */
    problems,
    setProblems,
    /** The example the project picker's highlighted entry would open, for a look before picking it. */
    peek,
    setPeek,
    onReveal(fn: typeof reveal) {
      reveal = fn;
    },
    /** Moves the editor's cursor to a 1-based line and column of the open file. */
    reveal: (line: number, column: number) => reveal(line, column),
    onOpenAt(fn: typeof openAt) {
      openAt = fn;
    },
    /** Opens `path` (or switches to its tab) with the cursor at a 1-based line and column. */
    openAt: (path: string, line: number, column: number) => openAt(path, line, column),
    onFormat(fn: () => void) {
      format = fn;
    },
    /** Formats the open file (`bun fmt`), as the Format button does. */
    format: () => format(),
    /** Writes every pending edit to the VFS now (before running, installing or sharing). */
    saveAll: () => saveAll(),
    /** Opens `path` in a tab (after the active one) or switches to its tab. */
    open(path: string) {
      setState((s) => {
        if (!s.open.includes(path)) s.open.splice(s.active ? s.open.indexOf(s.active) + 1 : s.open.length, 0, path);
        s.active = path;
      });
    },
    activate(path: string) {
      setState((s) => {
        s.active = path;
      });
    },
    close(path: string) {
      setState((s) => {
        const i = s.open.indexOf(path);
        if (i < 0) return;
        s.open.splice(i, 1);
        if (s.active === path) s.active = s.open[i] ?? s.open[i - 1] ?? null;
      });
    },
    closeAll() {
      setState((s) => {
        s.open = [];
        s.active = null;
      });
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
