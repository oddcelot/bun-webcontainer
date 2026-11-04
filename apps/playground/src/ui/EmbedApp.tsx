import { For, Show, createContext, createMemo, onSettled, useContext } from "solid-js";
import { Tip } from "@runbun/ui/solid/Tip";
import { Menu, MenuCheckItem, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "@runbun/ui/solid/Menu";
import logo from "../bun-logo.svg";
import { COST } from "../embed/config";
import { matches, type Command } from "../keymap";
import type { Embed } from "../embed/main";
import type { Feature } from "@runbun/embed/protocol";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { Splits, createSizes, type Split } from "./EmbedSplit";
import { FileTree } from "./FileTree";
import { Preview } from "./Preview";
import { StatusPill, StatusToast } from "./Status";
import { Unsupported } from "./Unsupported";

export const EmbedContext = createContext<Embed>();

const CANT_RUN = "This browser can't run code here";

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
  // Stacked, the tree stays out, as in a narrow frame.
  const tree = () => editor() && has("files") && !e.stacked();
  const side = e.side;
  const showTree = sticky(tree);
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
      if (matches("run", ev)) s.canRun && !s.busy.run && s.ready() && e.run();
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
  return (
    <div
      id="embed"
      data-mode={e.mode()}
      data-tree={tree() ? "" : undefined}
      data-editor={editor() ? "" : undefined}
      data-side={side() ? "" : undefined}
      data-stack={e.stacked() ? "" : undefined}
      data-fit={e.stacked() && e.fit() ? "" : undefined}
      data-preview={has("preview") ? "" : undefined}
      data-console={has("console") ? "" : undefined}
    >
      <EmbedBar />
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <div id="embed-main" style={sizes.vars()}>
        <Show when={showTree()}>
          <nav id="tree" class="pane" hidden={!tree()}>
            <FileTree />
          </nav>
        </Show>
        <section id="editor-pane" class="pane" hidden={!editor()}>
          <EditorPane />
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

function EmbedBar() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const s = app.session;
  const running = () => s.settled().state === "running";
  return (
    <header id="embed-bar">
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
      <button
        type="button"
        class="run"
        disabled={!s.canRun || !!s.busy.run}
        title={s.canRun ? undefined : CANT_RUN}
        onClick={() => s.ready() && (running() ? e.stop() : e.run())}
      >
        <i class={running() ? "i-lucide-square" : "i-lucide-play"} aria-hidden="true" /> {running() ? "Stop" : "Run"}
      </button>
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

const PANES: [Feature, string][] = [
  ["files", "Files"],
  ["tabs", "Tabs"],
  ["console", "Console"],
  ["preview", "Preview"],
];
const TOOLS: [Feature, string][] = [
  ["types", "Type hints"],
  ["format", "Formatting"],
  ["watch", "Restart on save"],
  ["autosave", "Auto-save switch"],
];

/** The ⋯ menu: panes and tools to turn on or off (what the author didn't lock), and actions. */
function EmbedMenu() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const open = (list: [Feature, string][]) => list.filter(([f]) => !e.locked.has(f));
  const Toggle = (props: { feature: Feature; label: string }) => (
    <MenuCheckItem checked={e.has(props.feature)} label={props.label} onSelect={() => e.setFeatures({ [props.feature]: !e.has(props.feature) }, true)}>
      <Show when={!e.has(props.feature) && COST[props.feature]}>{(cost) => <span class="cost">{cost()}</span>}</Show>
    </MenuCheckItem>
  );
  return (
    <Menu
      placement="bottom-end"
      class="embed-menu"
      trigger={
        <MenuTrigger class="more" aria-label="More">
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
      <MenuItem icon="i-lucide-rotate-ccw" label="Reset" onSelect={() => void e.reset()} />
      <Show when={e.has("open")}>
        <MenuItem icon={<img src={logo} alt="" width="14" height="12" />} label="Open in runbun.dev" onSelect={() => void e.openInPlayground()}>
          <i class="i-lucide-arrow-up-right" aria-hidden="true" />
        </MenuItem>
      </Show>
    </Menu>
  );
}
