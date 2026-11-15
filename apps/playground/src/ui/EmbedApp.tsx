import { For, Show, createContext, createEffect, createMemo, createSignal, onSettled, useContext } from "solid-js";
import { Tip } from "@runbun/ui/solid/Tip";
import { Menu, MenuCheckItem, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import logo from "../bun-logo.svg";
import { COST } from "../embed/config";
import { chordKeys, keysFor, matches, type Command } from "../keymap";
import type { Embed } from "../embed/main";
import type { Feature } from "@runbun/embed/protocol";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { Splits, createSizes, shareVars, withShares, type Split } from "./EmbedSplit";
import { Explorer, toggleGit } from "./Explorer";
import { inCommitBox } from "../git/store";
import { Gallery } from "./Gallery";
import { Preview } from "./Preview";
import { StatusPill, StatusToast } from "./Status";
import { Unsupported } from "./Unsupported";

export const EmbedContext = createContext<Embed>();

const CANT_RUN = "This browser can't run code here";
// embed.css's narrow frames, which drop the tree.
const NARROW = "(max-width: 560px)";
// Stacked, the tree sits beside the editor where the frame fits it (170px) and ~70 columns of 13px code with the
// gutter (600px), plus the grid's padding and gap.
const STACK_TREE = `(min-width: ${170 + 600 + 3 * 4}px)`;

const TREE: Split = { size: "tree", a: "tree", b: "editor-pane", label: "Resize file tree" };
const SIDE_PREVIEW: Split = { size: "side", a: "editor-pane", b: "preview-panel", label: "Resize editor and preview" };
const SIDE_CONSOLE: Split = { size: "side", a: "editor-pane", b: "console-wrap", label: "Resize editor and console" };
const ROWS: Split = { size: "rows", a: "preview-panel", b: "console-wrap", label: "Resize preview and console" };
const BELOW: Split = { size: "console", a: "editor-pane", b: "console-wrap", label: "Resize editor and console" };
// layout=stack: the editor over the side column, and the preview over the console.
const STACK_PREVIEW: Split = { size: "stack", a: "editor-pane", b: "preview-panel", label: "Resize editor and preview" };
const STACK_CONSOLE: Split = { size: "stack", a: "editor-pane", b: "console-wrap", label: "Resize editor and console" };
const STACK_ROWS: Split = { size: "console", a: "preview-panel", b: "console-wrap", label: "Resize preview and console" };

/** True from the first time `on()` is: a pane mounts once it's first shown and is only hidden after that (xterm and preview frames don't survive a remount). */
function sticky(on: () => boolean) {
  let was = false;
  return createMemo(() => (was ||= on()));
}

/**
 * The embed: a slim bar (file, status, Run, menu) over the panes its mode and features turn on, laid out on a grid
 * (embed.css): the editor with the console under it, or beside a column of preview over console, a file tree first.
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
  // Out of the grid (stacked without room, or a narrow frame), the tree opens over the editor instead: a drawer, from the bar.
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
  // Nothing in the bar but the ⋯ menu (EmbedBar's conditions): no bar, the menu at the end of the editor's tab bar.
  // The drawer's button is at the start of the tab bar wherever there is one, so it doesn't count.
  const barless = () => !e.library.length && editor() && has("tabs") && e.options.status !== "bar" && !has("run") && !e.options.expand;
  const showTree = sticky(() => tree() || drawer());
  const showPreview = sticky(() => has("preview"));
  const showConsole = sticky(() => has("console"));
  const sizes = createSizes(e.sizesKey);
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
  // A handle on each border between two shown panes, as the grid places them.
  const splits = () =>
    [
      tree() && TREE,
      side() && !e.stacked() && (has("preview") ? SIDE_PREVIEW : SIDE_CONSOLE),
      e.stacked() && (has("preview") ? STACK_PREVIEW : STACK_CONSOLE),
      e.stacked() && has("preview") && has("console") && STACK_ROWS,
      ((side() && !e.stacked()) || !editor()) && has("preview") && has("console") && ROWS,
      editor() && !side() && has("console") && BELOW,
    ].filter((s): s is Split => !!s);
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
        <EmbedBar drawer={drawerProps} />
      </Show>
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <div id="embed-main" style={withShares(shareVars(e.shares(), e.stacked(), e.fit()), sizes.vars())}>
        <Show when={showTree()}>
          <nav id="tree" class="pane" ref={nav} hidden={!tree() && !drawer()} style={drawer() ? { top: `${drawerTop()}px` } : undefined} onKeyDown={onDrawerKey}>
            <Explorer switcher />
          </nav>
        </Show>
        <section id="editor-pane" class="pane" hidden={!editor()}>
          <EditorPane
            start={
              <Show when={drawerOk() && has("tabs")}>
                <FilesButton drawer={drawerProps} />
              </Show>
            }
            end={
              <Show when={barless()}>
                <EmbedMenu />
              </Show>
            }
          />
        </section>
        <Show when={showPreview()}>
          <section id="preview-panel" class="pane" hidden={!has("preview")}>
            <Preview />
          </section>
        </Show>
        <Show when={showConsole()}>
          <section id="console-wrap" class="pane" hidden={!has("console")}>
            <Console />
          </section>
        </Show>
        <Splits splits={splits()} sizes={sizes} />
        <Show when={e.options.status === "toast"}>
          <StatusToast status={app.session.status()} />
        </Show>
      </div>
    </div>
  );
}

type Drawer = { ok: () => boolean; open: () => boolean; toggle: () => void; onKey: (ev: KeyboardEvent) => void; ref: (el: HTMLElement) => void };

/** Opens the file tree as a drawer: at the start of the editor's tab bar, or in the bar where there's none. */
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

function EmbedBar(props: { drawer: Drawer }) {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const s = app.session;
  const running = () => s.settled().state === "running";
  return (
    <header id="embed-bar">
      <Show when={props.drawer.ok() && !e.has("tabs")}>
        <FilesButton drawer={props.drawer} />
      </Show>
      <Show when={e.library.length}>
        <ProjectButton />
      </Show>
      <Show when={e.mode() !== "result" && !e.has("tabs")}>
        <span class="file">{app.workspace.state.active ?? ""}</span>
      </Show>
      <Show when={e.options.status === "bar"}>
        <StatusPill status={s.status()} />
      </Show>
      <span class="spacer" />
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
    </header>
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
            label="bun install"
            disabled={!app.session.canRun || !!app.session.busy.install}
            onSelect={() => app.session.ready() && e.install()}
          />
        </Show>
        {/* After the menu has closed and handed focus back, or that would take it from the dialog. */}
        <MenuItem icon="i-lucide-rotate-ccw" label="Reset" onSelect={() => (e.edited() ? setTimeout(() => setAsking(true), 50) : void e.reset())} />
        <Show when={e.has("open")}>
          <MenuItem icon={<img src={logo} alt="" width="14" height="12" />} label="Open in runbun.dev" onSelect={() => void e.openInPlayground()}>
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
