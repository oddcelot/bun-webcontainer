import { createStore } from "solid-js";

/**
 * Which files are open in tabs, and which one is active. Writes go through the functions below; the UI reads
 * `state`. Closing the active tab activates a neighbor.
 */
export function createWorkspace() {
  const [state, setState] = createStore({ open: [] as string[], active: null as string | null, treeVersion: 0 });
  return {
    state,
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
