import {
  FileTree,
  themeToTreeStyles,
  type FileTreeBatchOperation,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
} from "@pierre/trees";
import type { VFS } from "./vfs";

// Mirrors the editor chrome in style.css (One Dark).
const theme = themeToTreeStyles({
  type: "dark",
  bg: "#1b1d23",
  fg: "#d7dae0",
  colors: {
    "sideBar.background": "#1b1d23",
    "sideBar.foreground": "#d7dae0",
    "sideBar.border": "#2c2f36",
    "list.hoverBackground": "#262a31",
    "list.activeSelectionBackground": "#2f3542",
    "list.activeSelectionForeground": "#ffffff",
    "list.focusOutline": "#528bff",
    "input.background": "#14161a",
    "input.border": "#3a3f4a",
  },
});

const isDirectory = (item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle => item?.isDirectory() === true;

/** The VFS as a @pierre/trees file tree. Selecting a file calls `onOpen`. */
export function mountFileTree(mount: HTMLElement, vfs: VFS, onOpen: (path: string) => void) {
  const tree = new FileTree({
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
    for (const [k, v] of Object.entries(theme)) host.style.setProperty(k, v);
  }

  // An install writes thousands of files; add them in one batch per frame.
  let pending: FileTreeBatchOperation[] = [];
  vfs.onChange(({ path, created }) => {
    if (!created) return;
    if (!pending.length) {
      requestAnimationFrame(() => {
        const ops = pending;
        pending = [];
        tree.batch(ops.filter((op) => op.type === "add" && tree.getItem(op.path) === null));
      });
    }
    pending.push({ type: "add", path });
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
    /** Replaces every path, e.g. after the VFS was cleared and refilled. */
    reset() {
      tree.resetPaths([...vfs.files.keys()]);
    },
  };
}
