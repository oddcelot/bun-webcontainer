import { For, Show, createContext, createMemo, useContext } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import logo from "../bun-logo.svg";
import { COST } from "../embed/config";
import type { Embed } from "../embed/main";
import type { Feature } from "../embed/protocol";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Preview } from "./Preview";
import { Unsupported } from "./Unsupported";

export const EmbedContext = createContext<Embed>();

const CANT_RUN = "This browser can't run code here";

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
  const tree = () => editor() && has("files");
  // A column beside the editor: the preview, or the console in console mode.
  const side = () => editor() && (has("preview") || (e.mode() === "console" && has("console")));
  const showTree = sticky(tree);
  const showPreview = sticky(() => has("preview"));
  const showConsole = sticky(() => has("console"));
  return (
    <div
      id="embed"
      data-mode={e.mode()}
      data-tree={tree() ? "" : undefined}
      data-editor={editor() ? "" : undefined}
      data-side={side() ? "" : undefined}
      data-preview={has("preview") ? "" : undefined}
      data-console={has("console") ? "" : undefined}
    >
      <EmbedBar />
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <div id="embed-main">
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
      <span id="status" data-state={s.status().state}>
        <span class="text">{s.status().text}</span>
      </span>
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
        <button
          type="button"
          class="expand"
          aria-label={e.expanded() ? "Close the large view" : "Open in a large view"}
          title={e.expanded() ? "Close (Esc)" : "Open in a large view"}
          aria-pressed={e.expanded() ? "true" : "false"}
          onClick={() => e.requestExpand(!e.expanded())}
        >
          <i class={e.expanded() ? "i-lucide-minimize-2" : "i-lucide-maximize-2"} aria-hidden="true" />
        </button>
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
];

/** The ⋯ menu: panes and tools to turn on or off (what the author didn't lock), and actions. */
function EmbedMenu() {
  const app = useContext(AppContext);
  const e = useContext(EmbedContext);
  const open = (list: [Feature, string][]) => list.filter(([f]) => !e.locked.has(f));
  const Toggle = (props: { feature: Feature; label: string }) => (
    <DropdownMenu.Item class="select-option" closeOnSelect={false} onSelect={() => e.setFeatures({ [props.feature]: !e.has(props.feature) }, true)}>
      <span class="check" aria-hidden="true">
        <Show when={e.has(props.feature)}>
          <i class="i-lucide-check" />
        </Show>
      </span>
      <DropdownMenu.ItemLabel class="name">{props.label}</DropdownMenu.ItemLabel>
      <Show when={!e.has(props.feature) && COST[props.feature]}>{(cost) => <span class="cost">{cost()}</span>}</Show>
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu placement="bottom-end" gutter={6}>
      <DropdownMenu.Trigger class="more" aria-label="More">
        <i class="i-lucide-ellipsis" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="select-menu menu embed-menu">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="select-section">View</DropdownMenu.GroupLabel>
            <For each={open(PANES)}>{([f, label]) => <Toggle feature={f} label={label} />}</For>
          </DropdownMenu.Group>
          <Show when={open(TOOLS).length}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="select-section">Tools</DropdownMenu.GroupLabel>
              <For each={open(TOOLS)}>{([f, label]) => <Toggle feature={f} label={label} />}</For>
            </DropdownMenu.Group>
          </Show>
          <DropdownMenu.Separator class="separator" />
          <Show when={e.has("format")}>
            <DropdownMenu.Item class="select-option" disabled={!app.workspace.state.active} onSelect={() => app.workspace.format()}>
              <i class="i-lucide-wand-sparkles" aria-hidden="true" />
              <DropdownMenu.ItemLabel class="name">Format file</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <Show when={e.has("install")}>
            <DropdownMenu.Item class="select-option" disabled={!app.session.canRun || !!app.session.busy.install} onSelect={() => app.session.ready() && e.install()}>
              <i class="i-lucide-download" aria-hidden="true" />
              <DropdownMenu.ItemLabel class="name">bun install</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <DropdownMenu.Item class="select-option" onSelect={() => void e.reset()}>
            <i class="i-lucide-rotate-ccw" aria-hidden="true" />
            <DropdownMenu.ItemLabel class="name">Reset</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <Show when={e.has("open")}>
            <DropdownMenu.Item class="select-option" onSelect={() => void e.openInPlayground()}>
              <img src={logo} alt="" width="14" height="12" />
              <DropdownMenu.ItemLabel class="name">Open in runbun.dev</DropdownMenu.ItemLabel>
              <i class="i-lucide-arrow-up-right" aria-hidden="true" />
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
