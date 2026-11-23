import { Show, createEffect, createSignal, onSettled, untrack, useContext } from "solid-js";
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
import { Tip } from "@runbun/ui/solid/Tip";
import type { VFS } from "@runbun/vfs";
import { applyEdits, modify } from "jsonc-parser";
import { CONFIG_FILE, readConfig } from "../projectConfig";

// `git` keeps its repository in .git/ (thousands of objects); like git's own tools, the tree doesn't list it.
const inGitDir = (path: string) => /(^|\/)\.git(\/|$)/.test(path);
const inPackages = (path: string) => /(^|\/)node_modules(\/|$)/.test(path);
/** The files, and the folders with nothing in them (made here with New folder): a folder with files comes with those. */
const treePaths = (vfs: VFS) => {
  const files = [...vfs.files.keys()].filter((p) => !inGitDir(p));
  const filled = new Set<string>();
  for (const p of files) for (let i = p.lastIndexOf("/"); i > 0 && !filled.has(p.slice(0, i)); i = p.lastIndexOf("/", i - 1)) filled.add(p.slice(0, i));
  const empty = [...vfs.dirs].filter((d) => !filled.has(d) && !inGitDir(d) && !inPackages(d)).map((d) => `${d}/`);
  return [...files, ...empty];
};

const TREE_VARS_KEY = "tree-vars";
/** How long a rename or delete stays undoable (ms). */
const UNDO_FOR = 10_000;

/** How the project's tree looks. */
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

/** `disabled`: why it can't run now (the item's title); it stays in the menu, focusable, and does nothing. */
type MenuAction = { label: string; icon: string; keys?: string; disabled?: string; run(): void } | "separator";

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
  const items: HTMLButtonElement[] = [];
  for (const action of actions) {
    if (action === "separator") {
      const rule = document.createElement("hr");
      rule.setAttribute("role", "separator");
      menu.append(rule);
      continue;
    }
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
    if (action.disabled) {
      item.setAttribute("aria-disabled", "true");
      item.title = action.disabled;
    } else item.addEventListener("click", () => action.run());
    item.addEventListener("pointerenter", () => item.focus());
    item.addEventListener("focus", () => item.setAttribute("data-highlighted", ""));
    item.addEventListener("blur", () => item.removeAttribute("data-highlighted"));
    items.push(item);
    menu.append(item);
  }
  // Once it is in the page and has a size: back inside the window, if it would reach past the bottom or the right.
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
    if (r.right > innerWidth - 4) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  });
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
  /**
   * The VFS's files but those an embedding page generated, runbun.json while it's hidden (Settings), and what the
   * project hides (runbun.json `hiddenInTree`) unless the reader shows hidden files.
   */
  // What the project hides and whether the reader shows it, as last applied (the effect below): the tree's own
  // callbacks read these, not the signals.
  let hiddenPaths = untrack(ws.treeHidden);
  let showing = untrack(ws.showHidden);
  let configShown = untrack(ws.showConfig);
  const hiddenConfig = (path: string) => path === CONFIG_FILE && !configShown;
  const isHidden = (path: string) => hiddenPaths.some((p) => path === p || path.startsWith(`${p}/`));
  const outOfSight = (path: string) => !showing && isHidden(path);
  const paths = () => treePaths(vfs).filter((p) => !ws.isGenerated(p) && !hiddenConfig(p) && !outOfSight(vfsPath(p)));

  // Rename, delete and New file here, unless an embed is read-only.
  const editable = () => app.features?.has("edit") ?? true;
  /** Rename and delete for this row, unless runbun.json lists it in `readonly`. */
  const changeable = (path: string) => editable() && !ws.isReadonly(vfsPath(path));
  const [deleting, setDeleting] = createSignal<string | null>(null);
  /** The last rename or delete, undoable for a while: Undo in the notice under the tree, or Ctrl/Cmd+Z in it. */
  const [undo, setUndo] = createSignal<{ label: string; run(): Promise<void> } | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  function offerUndo(label: string, run: () => Promise<void>) {
    clearTimeout(undoTimer);
    setUndo({ label, run });
    undoTimer = setTimeout(() => setUndo(null), UNDO_FOR);
  }
  function runUndo() {
    const u = undo();
    if (!u) return;
    clearTimeout(undoTimer);
    setUndo(null);
    void u.run();
  }
  const [newFileAt, setNewFileAt] = createSignal("new.ts");
  /** What the dialog under the tree asks for: a new file's path, or a new folder's. */
  const [asking, setAsking] = createSignal<"file" | "folder" | null>(null);

  /** runbun.json's list under `key`, and whether the file can be edited here (it parses). */
  const configList = (key: "hidden" | "hiddenInTree" | "readonly") => {
    const problems: string[] = [];
    const config = readConfig((p) => vfs.readText(p), problems);
    return { list: config[key] ?? [], broken: problems.some((p) => p.includes("isn't valid JSON") || p.includes("must hold")) };
  };
  /** Adds `path` to runbun.json's list or takes it out, as Settings' form does: the rest of the file stays as it is. */
  function toggleInConfig(key: "hidden" | "hiddenInTree" | "readonly", path: string) {
    const { list } = configList(key);
    const next = list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
    // The editor's unsaved text of the file would otherwise overwrite this change on its next save.
    ws.saveAll();
    const before = vfs.readText(CONFIG_FILE) ?? `{\n  "$schema": "https://runbun.dev/schema/runbun.json"\n}\n`;
    const after = applyEdits(before, modify(before, [key], next.length ? next : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
    vfs.write(CONFIG_FILE, after);
    if (key === "readonly") return ws.setReadonly(next);
    if (key === "hiddenInTree") ws.setTreeHidden(next);
    // Out of the tabs from now on, not only the next time the project opens: the file, or a hidden folder's files.
    if (!next.includes(path) || (key === "hiddenInTree" && showing)) return;
    for (const tab of [...ws.state.open]) if (tab === path || tab.startsWith(`${path}/`)) ws.close(tab);
  }
  /** A copy beside the file ("util copy.ts", then "util copy 2.ts"), open and ready to be named. */
  function duplicate(path: string) {
    const data = vfs.read(path);
    if (data === undefined) return;
    const slash = path.lastIndexOf("/") + 1;
    const [dir, name] = [path.slice(0, slash), path.slice(slash)];
    const dot = name.indexOf(".", 1);
    const [stem, ext] = dot < 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
    let copy = `${dir}${stem} copy${ext}`;
    for (let n = 2; vfs.exists(copy); n++) copy = `${dir}${stem} copy ${n}${ext}`;
    vfs.write(copy, data);
    ws.open(copy);
    offerUndo(`Duplicated ${path}`, () => app.removePath(copy).then(() => {}));
    // Once the tree has the row (VFS changes reach it on the next frame).
    requestAnimationFrame(() => requestAnimationFrame(() => tree.getItem(copy) && tree.startRenaming(copy)));
  }

  const tree = new PierreTree({
    // A dot on files open in a tab.
    // And a ring on what the project hides, while the reader shows hidden files.
    renderRowDecoration: ({ item }) =>
      isHidden(vfsPath(item.path))
        ? { text: "○", title: "Hidden from the file tree (runbun.json)" }
        : item.kind === "file" && open.has(item.path)
          ? { text: "●", title: "Open in a tab" }
          : null,
    paths: untrack(paths),
    initialExpansion: "closed",
    search: true,
    ...TREE_LOOK,
    // Inline, in the row (F2, or Rename in the menu): the tree moves the row, the VFS follows.
    renaming: {
      canRename: (item) => changeable(item.path),
      onRename: ({ sourcePath, destinationPath }) => {
        const [from, to] = [vfsPath(sourcePath), vfsPath(destinationPath)];
        void app.renamePath(from, to).then((run) => offerUndo(`Renamed ${from} to ${to}`, run));
      },
      onError: (error) => app.log("warn", `[files] ${error}`),
    },
    onSelectionChange(paths) {
      const [path] = paths;
      if (paths.length === 1 && vfs.files.has(path) && path !== active) ws.open(path);
    },
  });

  function menuActions(item: ContextMenuItem, context: ContextMenuOpenContext): MenuAction[] {
    const path = vfsPath(item.path);
    const folder = item.kind === "directory";
    const actions: MenuAction[] = [];
    if (folder)
      actions.push(
        {
          label: "New file here…",
          icon: "i-lucide-file-plus",
          run() {
            context.close();
            setNewFileAt(`${item.path}new.ts`);
            setAsking("file");
          },
        },
        {
          label: "New folder here…",
          icon: "i-lucide-folder-plus",
          run() {
            context.close();
            setNewFileAt(`${item.path}new`);
            setAsking("folder");
          },
        },
        "separator",
      );
    // A read-only file or folder (runbun.json) keeps its name and stays: Rename and Delete are offered, disabled.
    const fixed = changeable(item.path) ? undefined : "read-only (runbun.json)";
    actions.push({
      label: "Rename…",
      icon: "i-lucide-pencil",
      keys: "F2",
      disabled: fixed,
      run() {
        // Focus goes to the rename field, not back to the row.
        context.close({ restoreFocus: false });
        tree.startRenaming(item.path);
      },
    });
    if (!folder)
      actions.push({
        label: "Duplicate",
        icon: "i-lucide-copy-plus",
        run() {
          context.close({ restoreFocus: false });
          duplicate(path);
        },
      });
    actions.push({
      label: "Copy path",
      icon: "i-lucide-clipboard",
      run() {
        context.close();
        navigator.clipboard.writeText(path).catch(() => app.log("warn", `[files] couldn't copy the path: ${path}`));
      },
    });
    // The project's own settings (runbun.json), which go with it when it is shared; not on runbun.json itself.
    if (path !== CONFIG_FILE) {
      const readonly = configList("readonly");
      const listed = readonly.list.includes(path);
      const inherited = !listed && ws.isReadonly(path);
      actions.push("separator", {
        label: listed ? "Make editable" : inherited ? "Read-only, as its folder" : "Make read-only",
        icon: listed ? "i-lucide-lock-open" : "i-lucide-lock",
        disabled: readonly.broken ? `fix ${CONFIG_FILE} first` : inherited ? "its folder is read-only" : undefined,
        run() {
          context.close();
          toggleInConfig("readonly", path);
        },
      });
      const tree = configList("hiddenInTree");
      const out = tree.list.includes(path);
      const under = !out && isHidden(path);
      actions.push({
        label: out ? "Show in the file tree again" : under ? "Hidden, as its folder" : "Hide from the file tree",
        icon: out ? "i-lucide-eye" : "i-lucide-eye-off",
        disabled: tree.broken ? `fix ${CONFIG_FILE} first` : under ? "its folder is hidden" : undefined,
        run() {
          context.close();
          toggleInConfig("hiddenInTree", path);
        },
      });
      if (!folder) {
        const hidden = configList("hidden");
        const kept = hidden.list.includes(path);
        actions.push({
          label: kept ? "Let it open in tabs again" : "Keep out of the tabs",
          icon: kept ? "i-lucide-panel-top-open" : "i-lucide-panel-top-close",
          disabled: hidden.broken ? `fix ${CONFIG_FILE} first` : undefined,
          run() {
            context.close();
            toggleInConfig("hidden", path);
          },
        });
      }
    }
    actions.push("separator", {
      label: "Delete…",
      icon: "i-lucide-trash-2",
      keys: "⌦",
      disabled: fixed,
      run() {
        context.close();
        setDeleting(item.path);
      },
    });
    return actions;
  }

  /**
   * Delete (or Ctrl/Cmd+Backspace) on a focused row asks to delete it; Ctrl/Cmd+Z undoes the last rename or delete. Not
   * while renaming or searching.
   */
  function onKeyDown(e: KeyboardEvent) {
    if ((e.composedPath()[0] as HTMLElement).closest?.("input, textarea")) return;
    if (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey && undo()) {
      e.preventDefault();
      return runUndo();
    }
    if (!(e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey)))) return;
    const path = tree.getFocusedPath();
    if (!path || !changeable(path)) return;
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
          // A removed folder takes everything in it: removing its files or subfolders after it would throw.
          const gone = ops.flatMap((op) => (op.type === "remove" && op.path.endsWith("/") ? [op.path] : []));
          const covered = (path: string) => gone.some((dir) => dir !== path && path.startsWith(dir));
          if (gone.length) ops.splice(0, ops.length, ...ops.filter((op) => !(op.type === "remove" && covered(op.path))));
          tree.batch(ops);
        });
      }
      pending.set(op.path, op);
    };
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if ((created || removed) && !inGitDir(path) && !ws.isGenerated(path) && !hiddenConfig(path) && !outOfSight(path)) queue({ type: removed ? "remove" : "add", path });
    });
    // The tree keeps a folder whose files are gone; a removed directory takes its row (and anything left in it).
    // And a folder made empty (New folder) gets one: its files would have brought it otherwise. Not an install's.
    const unsubscribeDirs = vfs.onDir((path, removed) => {
      if (inGitDir(path)) return;
      if (removed) queue({ type: "remove", path: `${path}/`, recursive: true });
      else if (!inPackages(path) && !outOfSight(path)) queue({ type: "add", path: `${path}/` });
    });
    // Files written between creating the tree and subscribing.
    tree.resetPaths(paths());
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
  // The repository's status, as badges and colors on the rows (the Git view's lists, in the tree).
  createEffect(
    () => app.git.statuses(),
    guarded("file tree", (entries) => {
      tree.setGitStatus(entries.length ? entries : undefined);
    }),
  );
  createEffect(
    () => [ws.state.treeVersion, ws.showConfig(), ws.treeHidden(), ws.showHidden()] as const,
    guarded("file tree", ([, config, hidden, shown]) => {
      configShown = config;
      hiddenPaths = hidden;
      showing = shown;
      tree.resetPaths(paths());
    }),
    { defer: true },
  );

  let button!: HTMLButtonElement;
  /** How many files a delete takes: one for a file, everything below a folder. */
  const fileCount = (path: string) => (path.endsWith("/") ? vfs.list(vfsPath(path)).length : 1);

  return (
    <>
      <div ref={host} style={{ height: "100%" }} onKeyDown={onKeyDown} />
      <Tip ref={(el: HTMLButtonElement) => (button = el)} id="newfile" type="button" tip="New file" aria-label="New file" onClick={() => {
          setNewFileAt("new.ts");
          setAsking("file");
        }}
      >
        <i class="i-lucide-file-plus" aria-hidden="true" />
      </Tip>
      <PromptDialog
        open={asking() !== null}
        onOpenChange={(open) => open || setAsking(null)}
        title={asking() === "folder" ? "New folder" : "New file"}
        label={asking() === "folder" ? "Folder path" : "File path"}
        initial={newFileAt()}
        submit="Create"
        check={(name) => (asking() === "folder" && vfs.exists(vfsPath(name)) ? `${vfsPath(name)} is there already` : undefined)}
        onSubmit={(name) => (asking() === "folder" ? vfs.mkdir(vfsPath(name)) : void app.newFile(name))}
        returnFocus={() => button}
      />
      <Show when={ws.treeHidden().length && !undo()}>
        <button type="button" class="tree-hidden" aria-pressed={ws.showHidden() ? "true" : "false"} onClick={() => ws.setShowHidden(!ws.showHidden())}>
          <i class={ws.showHidden() ? "i-lucide-eye" : "i-lucide-eye-off"} aria-hidden="true" />
          {ws.showHidden() ? "Showing" : "Show"} {ws.treeHidden().length} hidden
        </button>
      </Show>
      <Show when={undo()}>
        {(u) => (
          <div class="tree-undo" role="status">
            <span class="label">{u().label}</span>
            <button type="button" onClick={runUndo}>
              Undo
            </button>
          </div>
        )}
      </Show>
      <Dialog open={deleting() !== null} onOpenChange={(open) => open || setDeleting(null)}>
        <Show when={deleting()}>
          {(path) => (
            <>
              <DialogTitle>Delete {vfsPath(path())}?</DialogTitle>
              <DialogDescription>
                {path().endsWith("/")
                  ? `Deletes the folder and its ${fileCount(path())} ${fileCount(path()) === 1 ? "file" : "files"}.`
                  : "Deletes the file."}{" "}
                You can undo for a few seconds.
              </DialogDescription>
              <DialogActions>
                <DialogClose>Cancel</DialogClose>
                <Button
                  primary
                  onClick={() => {
                    const row = path();
                    setDeleting(null);
                    void app.removePath(vfsPath(row)).then((run) => offerUndo(`Deleted ${vfsPath(row)}`, run));
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
