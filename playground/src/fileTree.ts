import {
  FileTree,
  themeToTreeStyles,
  type FileTreeBatchOperation,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
} from "@pierre/trees";
import { onTheme } from "./theme";
import type { VFS } from "./vfs";

const isDirectory = (item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle => item?.isDirectory() === true;

/** The VFS as a @pierre/trees file tree. Selecting a file calls `onOpen`. */
export function mountFileTree(mount: HTMLElement, vfs: VFS, onOpen: (path: string) => void) {
  let open: ReadonlySet<string> = new Set();
  const tree = new FileTree({
    // A dot on files open in a tab.
    renderRowDecoration: ({ item }) =>
      item.kind === "file" && open.has(item.path) ? { text: "●", title: "Open in a tab", parts: [{ text: "●", color: "var(--accent)" }] } : null,
    paths: [...vfs.files.keys()],
    initialExpansion: "closed",
    search: true,
    icons: "standard",
    density: "compact",
    // @pierre/trees 1.0.0-beta.6 shows the truncation marker when the measure cell is `height > 1lh`;
    // at non-100% page zoom a single line measures a hair over 1lh, so every label gets "…".
    // A truncated label wraps to 2+ lines, so 1.5lh keeps real truncation working.
    unsafeCSS: `@container measure (height <= 1.5lh) { [data-truncate-marker] { opacity: 0; } }`,
    onSelectionChange(paths) {
      const [path] = paths;
      if (paths.length === 1 && vfs.files.has(path)) onOpen(path);
    },
  });
  tree.render({ containerWrapper: mount });
  const host = tree.getFileTreeContainer();
  if (host) {
    host.style.height = "100%";
    onTheme((_, theme) => {
      for (const [k, v] of Object.entries(themeToTreeStyles(theme))) host.style.setProperty(k, v);
    });
  }

  // An install writes thousands of files; apply them in one batch per frame.
  const pending = new Map<string, FileTreeBatchOperation & { type: "add" | "remove" }>();
  vfs.onChange(({ path, created, removed }) => {
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

  return {
    /** Reflects a file opened from code (startup, Open folder) as the tree's selection. */
    reveal(path: string, retry = true) {
      const item = tree.getItem(path);
      if (!item) {
        if (retry) requestAnimationFrame(() => this.reveal(path, false));
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
    },
    /** Marks the files open in tabs. */
    setOpen(paths: ReadonlySet<string>) {
      open = paths;
      tree.setIcons("standard"); // re-renders the rows, decorations included
    },
        /** Replaces every path, e.g. after the VFS was cleared and refilled. */
    reset() {
      tree.resetPaths([...vfs.files.keys()]);
    },
  };
}
