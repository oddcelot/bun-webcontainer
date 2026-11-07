import { Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import {
  FileTree as PierreTree,
  themeToTreeStyles,
  type FileTreeBatchOperation,
  type ContextMenuItem,
  type ContextMenuOpenContext,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
} from "@pierre/trees";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { onTheme } from "../theme";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import { PromptDialog } from "./PromptDialog";
import type { Peek } from "./workspace";
import { Tip } from "@runbun/ui/solid/Tip";

const TREE_VARS_KEY = "tree-vars";

/** How every tree here looks (the project's and a peeked example's). */
const TREE_LOOK = {
  icons: "standard",
  density: "compact",
  // @pierre/trees 1.0.0-beta.6 shows the truncation marker when the measure cell is `height > 1lh`;
  // at non-100% page zoom a single line measures a hair over 1lh, so every label gets "…".
  // A truncated label wraps to 2+ lines, so 1.5lh keeps real truncation working.
  // The open-file dot: small and quiet.
  // style.css's thin scrollbars: scrollbar-width doesn't inherit into the shadow root (the color does).
  // The search box sits in the pane like the tabs in the others: style.css's --pad in, a concentric corner. Its
  // right end leaves room for the New file button.
  unsafeCSS: `@container measure (height <= 1.5lh) { [data-truncate-marker] { opacity: 0; } }
      [data-item-section="decoration"] { font-size: 5px; color: var(--muted); opacity: 0.8; }
      * { scrollbar-width: thin; }
      [data-file-tree-search-container] { padding: var(--pad) calc(2 * var(--pad) + var(--control-height)) 4px var(--pad); }
      [data-file-tree-search-input] { flex: 1; min-width: 0; border-radius: var(--inner-radius); }`,
} as const;

/** Renders `tree` into `host` in the theme's colors (the last theme's until this one resolves); returns the cleanup. */
function mountTree(tree: PierreTree, host: HTMLElement) {
  tree.render({ containerWrapper: host });
  const el = tree.getFileTreeContainer();
  if (el) el.style.height = "100%";
  const applyStyles = (styles: Record<string, string>) => {
    for (const [k, v] of Object.entries(styles)) el?.style.setProperty(k, v);
  };
  // The last theme's tree colors until this one resolves, so the tree doesn't flash its dark default.
  try {
    applyStyles(JSON.parse(localStorage.getItem(TREE_VARS_KEY) ?? "{}"));
  } catch {}
  const untheme = onTheme((_, theme) => {
    const styles = themeToTreeStyles(theme) as Record<string, string>;
    applyStyles(styles);
    localStorage.setItem(TREE_VARS_KEY, JSON.stringify(styles));
  });
  return () => {
    untheme();
    tree.cleanUp();
  };
}

const isDirectory = (item: FileTreeItemHandle | null): item is FileTreeDirectoryHandle => item?.isDirectory() === true;

/** A tree path without a folder's trailing slash: the VFS's form. */
const vfsPath = (path: string) => path.replace(/\/$/, "");

type MenuAction = { label: string; icon: string; keys?: string; run(): void };

/**
 * A row's context menu, in the light DOM the tree slots in: styled like the app's menus (select.css), at the row's
 * menu button or the pointer, with ↑/↓ moving between the actions.
 */
function contextMenu(actions: MenuAction[], context: ContextMenuOpenContext): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "select-menu menu tree-menu";
  menu.setAttribute("role", "menu");
  const { top, bottom, left } = context.anchorRect;
  // A right-click's anchor is the pointer (no height); the row's button opens it below the button.
  Object.assign(menu.style, { position: "fixed", top: `${bottom > top ? bottom + 4 : top}px`, left: `${left}px` });
  const items = actions.map((action) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "select-option";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.innerHTML = `<i class="${action.icon}" aria-hidden="true"></i><span class="name"></span>`;
    item.querySelector(".name")!.textContent = action.label;
    if (action.keys) {
      const keys = document.createElement("kbd");
      keys.textContent = action.keys;
      item.append(keys);
    }
    item.addEventListener("click", () => action.run());
    item.addEventListener("pointerenter", () => item.focus());
    item.addEventListener("focus", () => item.setAttribute("data-highlighted", ""));
    item.addEventListener("blur", () => item.removeAttribute("data-highlighted"));
    return item;
  });
  menu.append(...items);
  menu.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + step + items.length) % items.length].focus();
  });
  return menu;
}

/** The VFS as a @pierre/trees file tree. Selecting a file opens it in a tab; files open in tabs get a dot. */
export function FileTree() {
  const app = useContext(AppContext);
  const { vfs, workspace: ws } = app;
  let host!: HTMLDivElement;
  let open: ReadonlySet<string> = new Set();
  // The active tab, as last applied. Selecting it below calls onSelectionChange from inside that effect.
  let active: string | null = null;

  // Rename, delete and New file here, unless an embed is read-only.
  const editable = () => app.features?.has("edit") ?? true;
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const [newFileAt, setNewFileAt] = createSignal("new.ts");

  const tree = new PierreTree({
    // A dot on files open in a tab.
    renderRowDecoration: ({ item }) => (item.kind === "file" && open.has(item.path) ? { text: "●", title: "Open in a tab" } : null),
    paths: [...vfs.files.keys()],
    initialExpansion: "closed",
    search: true,
    ...TREE_LOOK,
    // Inline, in the row (F2, or Rename in the menu): the tree moves the row, the VFS follows.
    renaming: {
      canRename: () => editable(),
      onRename: ({ sourcePath, destinationPath }) => void app.renamePath(vfsPath(sourcePath), vfsPath(destinationPath)),
      onError: (error) => app.log("warn", `[files] ${error}`),
    },
    onSelectionChange(paths) {
      const [path] = paths;
      if (paths.length === 1 && vfs.files.has(path) && path !== active) ws.open(path);
    },
  });

  function menuActions(item: ContextMenuItem, context: ContextMenuOpenContext): MenuAction[] {
    const actions: MenuAction[] = [
      {
        label: "Rename…",
        icon: "i-lucide-pencil",
        keys: "F2",
        run() {
          // Focus goes to the rename field, not back to the row.
          context.close({ restoreFocus: false });
          tree.startRenaming(item.path);
        },
      },
      {
        label: "Delete…",
        icon: "i-lucide-trash-2",
        keys: "⌦",
        run() {
          context.close();
          setDeleting(item.path);
        },
      },
    ];
    if (item.kind === "directory")
      actions.unshift({
        label: "New file here…",
        icon: "i-lucide-file-plus",
        run() {
          context.close();
          setNewFileAt(`${item.path}new.ts`);
          setAsking(true);
        },
      });
    return actions;
  }

  /** Delete (or Ctrl/Cmd+Backspace) on a focused row asks to delete it; not while renaming or searching. */
  function onKeyDown(e: KeyboardEvent) {
    if (!(e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey)))) return;
    if ((e.composedPath()[0] as HTMLElement).closest?.("input, textarea")) return;
    const path = tree.getFocusedPath();
    if (!path || !editable()) return;
    e.preventDefault();
    setDeleting(path);
  }

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
    const unmount = mountTree(tree, host);

    // An install writes thousands of files; apply them in one batch per frame.
    const pending = new Map<string, FileTreeBatchOperation & { type: "add" | "remove" }>();
    const queue = (op: FileTreeBatchOperation & { type: "add" | "remove" }) => {
      if (!pending.size) {
        requestAnimationFrame(() => {
          // The last change per path wins (a file written and removed in one frame isn't added).
          const ops = [...pending.values()].filter((op) => (op.type === "add") === (tree.getItem(op.path) === null));
          pending.clear();
          tree.batch(ops);
        });
      }
      pending.set(op.path, op);
    };
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (created || removed) queue({ type: removed ? "remove" : "add", path });
    });
    // The tree keeps a folder whose files are gone; a removed directory takes its row (and anything left in it).
    const unsubscribeDirs = vfs.onDir((path, removed) => {
      if (removed) queue({ type: "remove", path: `${path}/`, recursive: true });
    });
    // Files written between creating the tree and subscribing.
    tree.resetPaths([...vfs.files.keys()]);
    return () => {
      unsubscribe();
      unsubscribeDirs();
      unmount();
    };
  });

  // The rows' menu (right-click, or the ⋯ button) only while files can change: a read-only embed shows no button.
  createEffect(
    () => editable(),
    guarded("file tree", (on) => {
      tree.setComposition(on ? { contextMenu: { triggerMode: "both", render: (item, context) => contextMenu(menuActions(item, context), context) } } : undefined);
    }),
  );
  createEffect(
    () => [...ws.state.open],
    guarded("file tree", (paths) => {
      open = new Set(paths);
      tree.setIcons("standard"); // re-renders the rows, decorations included
    }),
  );
  createEffect(
    () => ws.state.active,
    guarded("file tree", (path) => {
      active = path;
      if (path) reveal(path);
      // No tab left: drop the closed file's selection, or clicking it again wouldn't be a change and wouldn't open it.
      else for (const p of tree.getSelectedPaths()) tree.getItem(p)?.deselect();
    }),
  );
  createEffect(
    () => ws.state.treeVersion,
    guarded("file tree", () => {
      tree.resetPaths([...vfs.files.keys()]);
    }),
    { defer: true },
  );

  const [asking, setAsking] = createSignal(false);
  let button!: HTMLButtonElement;
  /** How many files a delete takes: one for a file, everything below a folder. */
  const fileCount = (path: string) => (path.endsWith("/") ? vfs.list(vfsPath(path)).length : 1);

  return (
    <>
      <div ref={host} style={{ height: "100%" }} onKeyDown={onKeyDown} />
      {/* The example the project picker is on, over the project's files until the menu closes. */}
      <Show when={ws.peek()} keyed>
        {(peek) => <PeekTree peek={peek} />}
      </Show>
      <Tip ref={(el: HTMLButtonElement) => (button = el)} id="newfile" type="button" tip="New file" aria-label="New file" onClick={() => {
          setNewFileAt("new.ts");
          setAsking(true);
        }}
      >
        <i class="i-lucide-file-plus" aria-hidden="true" />
      </Tip>
      <PromptDialog
        open={asking()}
        onOpenChange={setAsking}
        title="New file"
        label="File path"
        initial={newFileAt()}
        submit="Create"
        onSubmit={(name) => app.newFile(name)}
        returnFocus={() => button}
      />
      <Dialog open={deleting() !== null} onOpenChange={(open) => open || setDeleting(null)}>
        <Show when={deleting()}>
          {(path) => (
            <>
              <DialogTitle>Delete {vfsPath(path())}?</DialogTitle>
              <DialogDescription>
                {path().endsWith("/")
                  ? `The folder and the ${fileCount(path())} ${fileCount(path()) === 1 ? "file" : "files"} in it are deleted.`
                  : "The file is deleted."}{" "}
                This can't be undone.
              </DialogDescription>
              <DialogActions>
                <DialogClose>Cancel</DialogClose>
                <Button
                  primary
                  onClick={() => {
                    const row = path();
                    setDeleting(null);
                    void app.removePath(vfsPath(row));
                  }}
                >
                  Delete
                </Button>
              </DialogActions>
            </>
          )}
        </Show>
      </Dialog>
    </>
  );
}

/** A peeked example's files, every folder open and the file the editor shows selected; nothing in it opens. */
function PeekTree(props: { peek: Peek }) {
  let host!: HTMLDivElement;
  onSettled(() => {
    const tree = new PierreTree({ paths: props.peek.paths, initialExpansion: "open", initialSelectedPaths: [props.peek.path], ...TREE_LOOK });
    return mountTree(tree, host);
  });
  return <div class="peek-tree" ref={host} aria-label={`Files of ${props.peek.title}`} />;
}
