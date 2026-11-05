import { For, Show, createEffect, createMemo, flush, useContext } from "solid-js";
import { chordKeys, keysFor, matches } from "../keymap";
import { AppContext } from "./context";
import { TabItem, TabList } from "@runbun/ui/solid/Tabs";
import { Tip } from "@runbun/ui/solid/Tip";

export { TabItem, TabList };

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** The Changes tab's value: no file path starts with NUL. */
const CHANGES = "\0changes";

/**
 * Open files as tabs above the editor. Middle-click, the ×, Delete or Ctrl/Cmd+W closes a tab (unless an embed turned
 * `close` off); arrows move between them.
 */
export function EditorTabs() {
  const { workspace: ws, features } = useContext(AppContext);
  const closable = () => features?.has("close") ?? true;
  // Same file name in two folders: those tabs show the folder too.
  const clashes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ws.state.open) counts.set(name(p), (counts.get(name(p)) ?? 0) + 1);
    return counts;
  });
  createEffect(
    () => [ws.state.active, ws.state.changesShown],
    () => {
      document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  );

  return (
    <TabList id="tabs" class="tabs tablist" label="Open files" onSelect={(path) => (path === CHANGES ? ws.showChanges() : (path !== ws.state.active || ws.state.changesShown) && ws.activate(path))}>
        {/* With no file open, an invisible tab holds the bar's height so the editor doesn't jump. */}
        <Show when={!ws.state.open.length && !ws.state.changes}>
          <div class="tab" aria-hidden="true" style={{ visibility: "hidden" }}>
            <span class="tab-trigger">
              <span class="name">&nbsp;</span>
            </span>
            <button class="close" tabindex={-1} disabled>
              <i class="i-lucide-x" />
            </button>
          </div>
        </Show>
        <For each={ws.state.open}>
          {(path) => (
            <TabItem
              value={path}
              selected={!ws.state.changesShown && ws.state.active === path}
              title={ws.readOnlyText(path) === undefined ? path : `${path} (read-only: not a project file)`}
              onClose={closable() ? () => ws.close(path) : undefined}
              closeLabel={`Close ${name(path)}`}
              onKeyDown={(e) => {
                if (closable() && matches("closeTab", e)) {
                  e.preventDefault();
                  ws.close(path);
                  // The focused tab is gone; keep keyboard focus in the bar, on the tab now selected.
                  flush();
                  document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.focus();
                }
              }}
            >
              <Show when={ws.readOnlyText(path) !== undefined}>
                <i class="i-lucide-lock" aria-label="read-only" />
              </Show>
              <span class="name">{name(path)}</span>
              {clashes().get(name(path))! > 1 && path.includes("/") && <span class="dir">{path.slice(0, path.lastIndexOf("/"))}</span>}
              <Show when={ws.state.dirty.includes(path)}>
                <Tip as="span" class="unsaved" tip="Unsaved changes" keys={keysFor("save").map(chordKeys)} aria-label="unsaved">
                  ●
                </Tip>
              </Show>
            </TabItem>
          )}
        </For>
        <Show when={ws.state.changes}>
          <TabItem
            value={CHANGES}
            selected={ws.state.changesShown}
            title="What differs from the project's source"
            onClose={() => ws.closeChanges()}
            closeLabel="Close Changes"
            onKeyDown={(e) => {
              if (matches("closeTab", e)) {
                e.preventDefault();
                ws.closeChanges();
                flush();
                document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.focus();
              }
            }}
          >
            <i class="i-lucide-git-compare" aria-hidden="true" />
            <span class="name">Changes</span>
          </TabItem>
        </Show>
    </TabList>
  );
}
