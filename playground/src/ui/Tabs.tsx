import { For, Show, createEffect, createMemo, createSignal, untrack, useContext, type ParentProps } from "solid-js";
import { Tabs } from "@kobalte/core/tabs";
import { AppContext } from "./context";

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The selected tab's value, a flush late. Kobalte Tabs finds its tabs in the DOM after they mount; given the
 * value of a tab added in the same update (Preview's "+"), it doesn't find it yet and falls back to selecting the
 * first tab, reporting that through onChange. Held a flush back, the old value is what it falls back to and
 * re-reports; callers drop an onChange equal to this value (a re-report, not a pick) instead of activating it.
 */
export function useTabValue(value: () => string) {
  const [shown, setShown] = createSignal(untrack(value));
  createEffect(value, (v) => {
    queueMicrotask(() => setShown(v));
  });
  return shown;
}

/**
 * One tab: Kobalte's trigger (the tab itself) with a close button beside it. The × can't live inside the trigger,
 * since a button in a button is invalid and the tab's accessible name would include "Close"; the wrapper draws the
 * tab and the two sit in it. Middle-click closes from anywhere on it.
 */
export function TabItem(
  props: ParentProps<{
    value: string;
    selected: boolean;
    title: string;
    /** Without this there's no ×. */
    onClose?: () => void;
    closeLabel?: string;
    onKeyDown?: (e: KeyboardEvent) => void;
  }>,
) {
  return (
    <div class="tab" role="presentation" data-selected={props.selected ? "" : undefined} onAuxClick={(e) => e.button === 1 && props.onClose?.()}>
      <Tabs.Trigger value={props.value} class="tab-trigger" title={props.title} onKeyDown={props.onKeyDown}>
        {props.children}
      </Tabs.Trigger>
      <Show when={props.onClose}>
        {(close) => (
          <button class="close" type="button" title={props.closeLabel} aria-label={props.closeLabel} tabindex={-1} onClick={() => close()()}>
            <i class="i-lucide-x" aria-hidden="true" />
          </button>
        )}
      </Show>
    </div>
  );
}

/** Open files as tabs above the editor. Middle-click, the ×, Delete or Ctrl/Cmd+W closes a tab; arrows move between them. */
export function EditorTabs(props: { placeholder?: boolean }) {
  const { workspace: ws } = useContext(AppContext);
  // Same file name in two folders: those tabs show the folder too.
  const clashes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ws.state.open) counts.set(name(p), (counts.get(name(p)) ?? 0) + 1);
    return counts;
  });
  const value = useTabValue(() => ws.state.active ?? "");
  createEffect(
    () => ws.state.active,
    () => {
      document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  );

  return (
    <Tabs class="tabs-root" value={value()} onChange={(path) => path !== value() && ws.activate(path)}>
      <Tabs.List id="tabs" class="tabs tablist" aria-label="Open files">
        {/* Until the project's first file opens, an invisible tab holds the bar's height so the editor doesn't jump. */}
        <Show when={props.placeholder}>
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
              selected={ws.state.active === path}
              title={path}
              onClose={() => ws.close(path)}
              closeLabel={`Close ${name(path)}`}
              onKeyDown={(e) => {
                if (e.key === "Delete" || (e.key === "w" && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault();
                  ws.close(path);
                }
              }}
            >
              <span class="name">{name(path)}</span>
              {clashes().get(name(path))! > 1 && path.includes("/") && <span class="dir">{path.slice(0, path.lastIndexOf("/"))}</span>}
              <Show when={ws.state.dirty.includes(path)}>
                <span class="unsaved" title="Unsaved changes (Ctrl/Cmd+S saves)" aria-label="unsaved">
                  ●
                </span>
              </Show>
            </TabItem>
          )}
        </For>
      </Tabs.List>
    </Tabs>
  );
}
