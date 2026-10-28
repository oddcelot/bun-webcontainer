import { createEffect, onSettled, useContext } from "solid-js";
import {
  FileTree as PierreTree,
  themeToTreeStyles,
  type FileTreeBatchOperation,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
} from "@pierre/trees";
import { onTheme } from "../theme";
import { AppContext } from "./context";

const isDirectory = (item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle => item?.isDirectory() === true;

/** The VFS as a @pierre/trees file tree. Selecting a file opens it in a tab; files open in tabs get a dot. */
export function FileTree() {
  const { vfs, workspace: ws } = useContext(AppContext);
  let host!: HTMLDivElement;
  let open: ReadonlySet<string> = new Set();
  // The active tab, as last applied. Selecting it below calls onSelectionChange from inside that effect.
  let active: string | null = null;

  const tree = new PierreTree({
    // A dot on files open in a tab.
    renderRowDecoration: ({ item }) => (item.kind === "file" && open.has(item.path) ? { text: "●", title: "Open in a tab" } : null),
    paths: [...vfs.files.keys()],
    initialExpansion: "closed",
    search: true,
    icons: "standard",
    density: "compact",
    // @pierre/trees 1.0.0-beta.6 shows the truncation marker when the measure cell is `height > 1lh`;
    // at non-100% page zoom a single line measures a hair over 1lh, so every label gets "…".
    // A truncated label wraps to 2+ lines, so 1.5lh keeps real truncation working.
    // The open-file dot: small and quiet.
    unsafeCSS: `@container measure (height <= 1.5lh) { [data-truncate-marker] { opacity: 0; } }
      [data-item-section="decoration"] { font-size: 5px; color: var(--muted); opacity: 0.8; }`,
    onSelectionChange(paths) {
      const [path] = paths;
      if (paths.length === 1 && vfs.files.has(path) && path !== active) ws.open(path);
    },
  });

  /** Reflects the active tab as the tree's selection, expanding its folders. */
  function reveal(path: string, retry = true) {
    const item = tree.getItem(path);
    if (!item) {
      // Not added yet: VFS changes reach the tree on the next frame.
      if (retry) requestAnimationFrame(() => reveal(path, false));
      return;
    }
    if (item.isSelected()) return;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = tree.getItem(`${parts.slice(0, i).join("/")}/`);
      if (isDirectory(dir) && !dir.isExpanded()) dir.expand();
    }
    for (const p of tree.getSelectedPaths()) tree.getItem(p)?.deselect();
    item.select();
    tree.scrollToPath(path);
  }

  onSettled(() => {
    tree.render({ containerWrapper: host });
    const el = tree.getFileTreeContainer();
    if (el) el.style.height = "100%";
    const untheme = onTheme((_, theme) => {
      for (const [k, v] of Object.entries(themeToTreeStyles(theme))) el?.style.setProperty(k, v);
    });

    // An install writes thousands of files; apply them in one batch per frame.
    const pending = new Map<string, FileTreeBatchOperation & { type: "add" | "remove" }>();
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (!created && !removed) return;
      if (!pending.size) {
        requestAnimationFrame(() => {
          // The last change per path wins (a file written and removed in one frame isn't added).
          const ops = [...pending.values()].filter((op) => (op.type === "add") === (tree.getItem(op.path) === null));
          pending.clear();
          tree.batch(ops);
        });
      }
      pending.set(path, { type: removed ? "remove" : "add", path });
    });
    // Files written between creating the tree and subscribing.
    tree.resetPaths([...vfs.files.keys()]);
    return () => {
      unsubscribe();
      untheme();
      tree.cleanUp();
    };
  });

  createEffect(
    () => [...ws.state.open],
    (paths) => {
      open = new Set(paths);
      tree.setIcons("standard"); // re-renders the rows, decorations included
    },
  );
  createEffect(
    () => ws.state.active,
    (path) => {
      active = path;
      if (path) reveal(path);
    },
  );
  createEffect(
    () => ws.state.treeVersion,
    () => {
      tree.resetPaths([...vfs.files.keys()]);
    },
    { defer: true },
  );

  return <div ref={host} style={{ height: "100%" }} />;
}
