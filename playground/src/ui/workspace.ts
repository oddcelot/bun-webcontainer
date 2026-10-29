import { createStore } from "solid-js";

const AUTOSAVE_KEY = "runbun:autosave";

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
    /** Save edits shortly after typing stops; off, they wait for Ctrl/Cmd+S, Run, Install or Share. */
    autosave: localStorage.getItem(AUTOSAVE_KEY) !== "off",
  });
  // The editor's pending edits; it registers how to write them (see EditorPane).
  let saveAll = () => {};
  return {
    state,
    setDirty(path: string, dirty: boolean) {
      setState((s) => {
        const i = s.dirty.indexOf(path);
        if (dirty && i < 0) s.dirty.push(path);
        else if (!dirty && i >= 0) s.dirty.splice(i, 1);
      });
    },
    setAutosave(on: boolean) {
      localStorage.setItem(AUTOSAVE_KEY, on ? "on" : "off");
      setState((s) => {
        s.autosave = on;
      });
    },
    onSaveAll(fn: () => void) {
      saveAll = fn;
    },
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
