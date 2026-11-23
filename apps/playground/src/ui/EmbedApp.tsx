import { For, Show, createContext, createEffect, createMemo, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Tiling, createTiling, type TilingLayout } from "@runbun/ui/solid/Tiling";
import { Tip } from "@runbun/ui/solid/Tip";
import { Menu, MenuCheckItem, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import logo from "../bun-logo.svg";
import { COST, PANE_GAP } from "../embed/config";
import { chordKeys, keysFor, matches, type Command } from "../keymap";
import type { Embed } from "../embed/main";
import type { Feature } from "@runbun/embed/protocol";
import { AppContext } from "./context";
import { Dock } from "./Dock";
import { EditorPane } from "./EditorPane";
import { PANES as TILES, buildLayout, createSizes, type Built, type Pane, type Shape } from "./EmbedLayout";
import { Explorer, toggleGit } from "./Explorer";
import { inCommitBox } from "../git/store";
import { Gallery } from "./Gallery";
import { Preview } from "./Preview";
import { StatusPill, StatusToast } from "./Status";
import { Unsupported } from "./Unsupported";
import { HOSTING } from "../hosting";

export const EmbedContext = createContext<Embed>();

const CANT_RUN = "This browser can't run code here";
// Narrow frames put the side column under the editor, and drop the tree.
const NARROW = "(max-width: 560px)";
// Stacked, the tree sits beside the editor where the frame fits it (170px) and ~70 columns of 13px code with the
// gutter (600px), plus the room's padding and the gap.
const STACK_TREE = `(min-width: ${170 + 600 + 3 * 4}px)`;

/** True from the first time `on()` is: a pane mounts once it's first shown and is only hidden after that (xterm and preview frames don't survive a remount). */
function sticky(on: () => boolean) {
  let was = false;
  return createMemo(() => (was ||= on()));
}

/**
 * The embed: its controls (status, Run, menu) in the editor's tab bar, or in a slim bar over the panes where there's
 * none (with the file's name), and the panes its mode and features turn on, as tiles of a layout that is the embed's
 * to decide (ui/EmbedLayout.ts): the editor with the console under it, or beside a column of preview over console, a
 * file tree first. A reader drags the borders between them, and no more.
 */
export function EmbedApp() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const has = (f: Feature) => e.has(f);
  const editor = () => e.mode() !== "result";
  const narrowQuery = matchMedia(NARROW);
  const [narrow, setNarrow] = createSignal(narrowQuery.matches);
  const roomyQuery = matchMedia(STACK_TREE);
  const [roomy, setRoomy] = createSignal(roomyQuery.matches);
  const tree = () => editor() && has("files") && (!e.stacked() || roomy());
  const side = e.side;
  // Out of the layout (stacked without room, or a narrow frame), the tree opens over the editor instead: a drawer, from the bar.
  const drawerOk = () => editor() && has("files") && (e.stacked() ? !roomy() : narrow());
  const [open, setOpen] = createSignal(false);
  const drawer = () => open() && drawerOk();
  let nav: HTMLElement | undefined;
  let filesButton: HTMLElement | undefined;
  const closeDrawer = (refocus = false) => {
    setOpen(false);
    if (refocus) filesButton?.focus();
  };
  // Into the tree: its focused row, else its search box (rows may take a frame to render after the first open).
  const focusDrawer = (tries = 3) =>
    requestAnimationFrame(() => {
      const root = nav?.querySelector("file-tree-container")?.shadowRoot;
      const target = root?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? root?.querySelector<HTMLElement>("input");
      if (target) target.focus();
      else if (tries) focusDrawer(tries - 1);
    });
  // Under the editor's tab bar when its button is there, so the button stays in sight.
  const [drawerTop, setDrawerTop] = createSignal(0);
  const toggleDrawer = () => {
    if (drawer()) return closeDrawer();
    setDrawerTop(has("tabs") ? (document.querySelector<HTMLElement>("#editor-pane > .tabs-bar")?.offsetHeight ?? 0) : 0);
    setOpen(true);
    focusDrawer();
  };
  const onDrawerKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !drawer()) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeDrawer(true);
  };
  // A file picked in it closes it.
  createEffect(
    () => app.workspace.state.active,
    () => closeDrawer(),
    { defer: true },
  );
  onSettled(() => {
    const onChange = () => {
      setNarrow(narrowQuery.matches);
      setRoomy(roomyQuery.matches);
      setOpen(false);
    };
    narrowQuery.addEventListener("change", onChange);
    roomyQuery.addEventListener("change", onChange);
    // A press outside it (but in a dialog it opened) closes it.
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Element;
      if (drawer() && !nav?.contains(t) && !filesButton?.contains(t) && !t.closest?.('[role="dialog"]')) closeDrawer();
    };
    addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      narrowQuery.removeEventListener("change", onChange);
      roomyQuery.removeEventListener("change", onChange);
      removeEventListener("pointerdown", onDown, { capture: true });
    };
  });
  // Where the editor shows its tab bar, the bar's controls are in it, and there's no bar.
  // The large view has room for its own bar.
  const barless = () => editor() && has("tabs") && !e.expanded();
  const showTree = sticky(() => tree() || drawer());
  const showPreview = sticky(() => has("preview"));
  const showConsole = sticky(() => has("console"));
  const sizes = createSizes(e.sizesKey);
  const shape = (): Shape => ({
    editor: editor(),
    tree: tree() && !narrow(),
    side: side(),
    stacked: e.stacked(),
    fit: e.stacked() && e.fit(),
    narrow: narrow(),
    preview: has("preview"),
    console: has("console"),
    // Only where it places something, so that a measurement elsewhere doesn't lay the panes out again.
    fitPreview: e.stacked() && e.fit() && has("preview") ? e.fitPreview() : 0,
    shares: e.shares(),
  });
  // The tree as last built: its borders' names and labels, by their path in it.
  let built: Built = buildLayout(untrack(shape), sizes.get());
  const layout = (): TilingLayout<Pane> => {
    built = buildLayout(untrack(shape), sizes.get());
    return { tree: built.tree, hidden: TILES.filter((p) => !built.shown.includes(p)), floating: {} };
  };
  const tiling = createTiling<Pane>({ tiles: TILES, defaultLayout: layout(), gap: PANE_GAP, minSize: { width: 110, height: 60 }, movable: false, animated: false });
  createEffect(
    () => JSON.stringify(shape()),
    () => tiling.setLayout(layout()),
    { defer: true },
  );
  // The drawer: over the editor's left edge, as wide as the tree would be.
  const drawerStyle = () => {
    const over = tiling.rect("editor");
    return over ? { left: `${over.x}px`, top: `${over.y + drawerTop()}px`, width: `${sizes.get().tree ?? 170}px`, height: `${over.h - drawerTop()}px` } : {};
  };
  // The app's shortcuts (App.tsx has them in the playground), on the way down and stopped there, so the editor doesn't
  // get a key that ran a command (its keymap has Mod+Enter as "insert a blank line"). The show and hide ones work the
  // menu's switches, so a pane the author locked stays as it is.
  onSettled(() => {
    const panes: [Command, Feature][] = [
      ["toggleExplorer", "files"],
      ["toggleConsole", "console"],
      ["togglePreview", "preview"],
    ];
    const onKey = (ev: KeyboardEvent) => {
      const s = app.session;
      const pane = panes.find(([c, f]) => matches(c, ev) && !e.locked.has(f))?.[1];
      if (inCommitBox(ev) && matches("run", ev)) return;
      if (drawerOk() && matches("toggleExplorer", ev)) toggleDrawer();
      else if (matches("toggleGit", ev)) {
        if (!toggleGit(app, tree())) return;
      } else if (matches("run", ev)) s.canRun && !s.busy.run && s.ready() && e.run();
      else if (matches("stop", ev)) e.stop();
      else if (pane) e.setFeatures({ [pane]: !e.has(pane) }, true);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  });
  const drawerProps: Drawer = { ok: drawerOk, open: drawer, toggle: toggleDrawer, onKey: onDrawerKey, ref: (el: HTMLElement) => (filesButton = el) };
  return (
    <div
      id="embed"
      data-mode={e.mode()}
      data-tree={tree() ? "" : undefined}
      data-drawer={drawer() ? "" : undefined}
      data-editor={editor() ? "" : undefined}
      data-side={side() ? "" : undefined}
      data-stack={e.stacked() ? "" : undefined}
      data-fit={e.stacked() && e.fit() ? "" : undefined}
      data-preview={has("preview") ? "" : undefined}
      data-console={has("console") ? "" : undefined}
      data-barless={barless() ? "" : undefined}
    >
      <Show when={!barless()}>
        <header id="embed-bar">
          <BarStart drawer={drawerProps} />
          <BarEnd />
        </header>
      </Show>
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <div id="embed-main">
        <Tiling tiling={tiling}>
          <Tiling.Tile
            tileId="tree"
            id="tree"
            class="pane"
            role="navigation"
            aria-label="Files"
            ref={(el: HTMLElement) => (nav = el)}
            hidden={!shape().tree && !drawer()}
            unplaced={drawer()}
            style={drawer() ? drawerStyle() : undefined}
            onKeyDown={onDrawerKey}
          >
            <Show when={showTree()}>
              <Explorer switcher />
            </Show>
          </Tiling.Tile>
          <Tiling.Tile tileId="editor" id="editor-pane" class="pane" aria-label="Editor" hidden={!editor()}>
            <EditorPane
              start={
                <Show when={barless()}>
                  <BarStart drawer={drawerProps} />
                </Show>
              }
              end={
                <Show when={barless()}>
                  <BarEnd />
                </Show>
              }
            />
          </Tiling.Tile>
          <Tiling.Tile tileId="preview" id="preview-panel" class="pane" aria-label="Preview" hidden={!has("preview")}>
            <Show when={showPreview()}>
              <Preview />
            </Show>
          </Tiling.Tile>
          <Tiling.Tile tileId="console" id="console-wrap" class="pane" aria-label="Console" hidden={!has("console")}>
            <Show when={showConsole()}>
              <Dock />
            </Show>
          </Tiling.Tile>
          <Tiling.Handles
            labelFor={(path) => built.labels[path]}
            onSplitResize={(path, size) => built.names[path] && sizes.moved(built.names[path], size)}
            onSplitReset={(path) => {
              if (!built.names[path]) return;
              sizes.reset(built.names[path]);
              tiling.setLayout(layout());
            }}
          />
        </Tiling>
        <Show when={e.options.status === "toast"}>
          <StatusToast status={app.session.status()} />
        </Show>
      </div>
    </div>
  );
}

type Drawer = { ok: () => boolean; open: () => boolean; toggle: () => void; onKey: (ev: KeyboardEvent) => void; ref: (el: HTMLElement) => void };

/** Opens the file tree as a drawer. */
function FilesButton(props: { drawer: Drawer }) {
  return (
    <Tip
      type="button"
      class="files"
      ref={props.drawer.ref}
      tip="Files"
      keys={keysFor("toggleExplorer").map(chordKeys)}
      aria-label="Files"
      aria-expanded={props.drawer.open() ? "true" : "false"}
      aria-controls="tree"
      onClick={props.drawer.toggle}
      onKeyDown={props.drawer.onKey}
    >
      <i class="i-lucide-panel-left" aria-hidden="true" />
    </Tip>
  );
}

/** The bar's controls before the tabs (or the file's name): the drawer's button, the library's project button. */
function BarStart(props: { drawer: Drawer }) {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  return (
    <div class="controls start">
      <Show when={props.drawer.ok()}>
        <FilesButton drawer={props.drawer} />
      </Show>
      <Show when={e.library.length}>
        <ProjectButton />
      </Show>
      <Show when={e.mode() !== "result" && !e.has("tabs")}>
        <span class="file">{app.workspace.state.active ?? ""}</span>
      </Show>
    </div>
  );
}

/** The bar's controls after the tabs: the status pill, Edit (result mode), Run/Stop, expand and the ⋯ menu. */
function BarEnd() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const s = app.session;
  const running = () => s.settled().state === "running";
  return (
    <div class="controls end">
      <Show when={e.options.status === "bar"}>
        <StatusPill status={s.status()} />
      </Show>
      <Show when={e.mode() === "result"}>
        <button type="button" onClick={() => e.setMode("preview")}>
          <i class="i-lucide-code" aria-hidden="true" /> Edit
        </button>
      </Show>
      <Show when={e.has("run")}>
        <button
          type="button"
          class="run"
          disabled={!s.canRun || !!s.busy.run}
          title={s.canRun ? undefined : CANT_RUN}
          onClick={() => s.ready() && (running() ? e.stop() : e.run())}
        >
          <i class={running() ? "i-lucide-square" : "i-lucide-play"} aria-hidden="true" /> {running() ? "Stop" : "Run"}
        </button>
      </Show>
      <Show when={e.options.expand}>
        <Tip
          type="button"
          class="expand"
          tip={e.expanded() ? "Close the large view" : "Open in a large view"}
          keys={e.expanded() ? ["Esc"] : undefined}
          aria-label={e.expanded() ? "Close the large view" : "Open in a large view"}
          aria-pressed={e.expanded() ? "true" : "false"}
          onClick={() => e.requestExpand(!e.expanded())}
        >
          <i class={e.expanded() ? "i-lucide-minimize-2" : "i-lucide-maximize-2"} aria-hidden="true" />
        </Tip>
      </Show>
      <EmbedMenu />
    </div>
  );
}

/** The host's library (`library`): a button naming the open project, which opens a gallery of only those. */
function ProjectButton() {
  const e = useContext(EmbedContext);
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  const current = () => e.library.find((p) => p.value === e.project());
  return (
    <>
      <button ref={trigger} type="button" class="project" aria-haspopup="dialog" title="Open another project" onClick={() => setOpen(true)}>
        <Show when={current()} fallback={<i class="i-lucide-folder-code" aria-hidden="true" />}>
          {(c) => <i class={c().icon} aria-hidden="true" />}
        </Show>
        <span class="name">{current()?.name ?? "Projects"}</span>
        <i class="i-lucide-chevrons-up-down chevron" aria-hidden="true" />
      </button>
      {/* Controlled, so Kobalte has no trigger of its own to hand focus back to. */}
      <Dialog
        open={open()}
        onOpenChange={setOpen}
        class="gallery"
        onCloseAutoFocus={(ev) => {
          ev.preventDefault();
          trigger.focus();
        }}
      >
        <Gallery
          catalog={e.library}
          selected={e.project()}
          onPick={(p) => {
            setOpen(false);
            void e.openProject(p.value).catch(() => {});
          }}
          onClose={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}

const PANES: [Feature, string][] = [
  ["files", "Files"],
  ["tabs", "Tabs"],
  ["console", "Console"],
  ["preview", "Preview"],
];
const TOOLS: [Feature, string][] = [
  ["types", "Type hints"],
  ["format", "Formatting"],
  ["git", "Git"],
  ["watch", "Restart on save"],
  ["autosave", "Auto-save"],
];

/** The ⋯ menu: panes and tools to turn on or off (what the author didn't lock), and actions. */
function EmbedMenu() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const open = (list: [Feature, string][]) => list.filter(([f]) => !e.locked.has(f));
  const shownPort = () => app.session.previewPort() ?? app.session.ports()[0];
  // Reset asks first when it would lose the reader's edits.
  const [asking, setAsking] = createSignal(false);
  let trigger: HTMLElement | undefined;
  const Toggle = (props: { feature: Feature; label: string }) => (
    <MenuCheckItem checked={e.has(props.feature)} label={props.label} onSelect={() => e.setFeatures({ [props.feature]: !e.has(props.feature) }, true)}>
      <Show when={!e.has(props.feature) && COST[props.feature]}>{(cost) => <span class="cost">{cost()}</span>}</Show>
    </MenuCheckItem>
  );
  return (
    <>
      <Menu
        placement="bottom-end"
        class="embed-menu"
        trigger={
          <MenuTrigger ref={trigger} class="more" aria-label="More">
            <i class="i-lucide-ellipsis" aria-hidden="true" />
          </MenuTrigger>
        }
      >
        <MenuGroup label="View">
          <For each={open(PANES)}>{([f, label]) => <Toggle feature={f} label={label} />}</For>
        </MenuGroup>
        <Show when={open(TOOLS).length}>
          <MenuGroup label="Tools">
            <For each={open(TOOLS)}>{([f, label]) => <Toggle feature={f} label={label} />}</For>
          </MenuGroup>
        </Show>
        {/* With several servers (the program's, its child processes'), which one the preview shows. */}
        <Show when={app.session.ports().length > 1}>
          <MenuGroup label="Preview port">
            <For each={app.session.ports()}>
              {(port) => (
                <MenuItem
                  icon={port === shownPort() ? "i-lucide-check" : "i-lucide-check invisible"}
                  label={`:${port}`}
                  onSelect={() => port !== shownPort() && app.choosePort(port)}
                >
                  <Show when={port === shownPort()}>
                    <span class="sr-only">(shown)</span>
                  </Show>
                </MenuItem>
              )}
            </For>
          </MenuGroup>
        </Show>
        <MenuSeparator />
        <Show when={e.has("format")}>
          <MenuItem icon="i-lucide-wand-sparkles" label="Format file" disabled={!app.workspace.state.active} onSelect={() => app.workspace.format()} />
        </Show>
        <Show when={e.has("install")}>
          <MenuItem
            icon="i-lucide-download"
            label="Install dependencies"
            disabled={!app.session.canRun || !!app.session.busy.install}
            onSelect={() => app.session.ready() && e.install()}
          />
        </Show>
        {/* After the menu has closed and handed focus back, or that would take it from the dialog. */}
        <MenuItem icon="i-lucide-rotate-ccw" label="Reset" onSelect={() => (e.edited() ? setTimeout(() => setAsking(true), 50) : void e.reset())} />
        <Show when={e.has("open")}>
          <MenuItem icon={<img src={HOSTING.brand?.logo ?? logo} alt="" width="14" height="12" style={{ "object-fit": "contain" }} />} label={`Open in ${HOSTING.name}`} onSelect={() => void e.openInPlayground()}>
            <i class="i-lucide-arrow-up-right" aria-hidden="true" />
          </MenuItem>
        </Show>
      </Menu>
      <Dialog
        open={asking()}
        onOpenChange={setAsking}
        onCloseAutoFocus={(ev) => {
          ev.preventDefault();
          trigger?.focus();
        }}
      >
        <DialogTitle>Reset this project?</DialogTitle>
        <DialogDescription>Your changes will be lost.</DialogDescription>
        <DialogActions>
          <DialogClose>Cancel</DialogClose>
          <Button
            primary
            onClick={() => {
              setAsking(false);
              void e.reset();
            }}
          >
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
