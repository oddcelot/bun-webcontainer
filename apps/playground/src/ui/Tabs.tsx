import { For, Show, createEffect, createMemo, flush, useContext, type ParentProps } from "solid-js";
import { formatChord, keysFor, matches } from "../keymap";
import { AppContext } from "./context";
import { Tip } from "@runbun/ui/solid/Tip";

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A row of tabs (role tablist), each a `TabItem`. Selection is the caller's: a click, or the arrow keys, Home and End
 * (which move focus and select, without wrapping), call `onSelect` with the tab's value. The selected tab is the one
 * Tab-key focus lands on. The row scrolls sideways with no scrollbar, so a vertical wheel scrolls it too.
 */
export function TabList(props: ParentProps<{ id?: string; class?: string; label: string; onSelect: (value: string) => void }>) {
  const tabs = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  const select = (tab: HTMLElement | undefined) => tab && props.onSelect(tab.dataset.value!);
  return (
    <div
      id={props.id}
      class={props.class}
      role="tablist"
      aria-label={props.label}
      aria-orientation="horizontal"
      onWheel={(e) => {
        const list = e.currentTarget;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
        e.preventDefault();
        list.scrollLeft += e.deltaY;
      }}
      onClick={(e) => select((e.target as HTMLElement).closest<HTMLElement>('[role="tab"]') ?? undefined)}
      onKeyDown={(e) => {
        const all = tabs(e.currentTarget);
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        const next = { ArrowLeft: all[i - 1], ArrowRight: all[i + 1], Home: all[0], End: all[all.length - 1] }[e.key];
        if (!next) return;
        e.preventDefault();
        next.focus();
        select(next);
      }}
    >
      {props.children}
    </div>
  );
}

/**
 * One tab: the tab button with a close button beside it. The × can't live inside the tab, since a button in a
 * button is invalid and the tab's accessible name would include "Close"; the wrapper draws the tab and the two sit
 * in it. Middle-click closes from anywhere on it.
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
      <Tip
        type="button"
        role="tab"
        class="tab-trigger"
        data-value={props.value}
        aria-selected={props.selected ? "true" : "false"}
        tabindex={props.selected ? 0 : -1}
        tip={props.title}
        onKeyDown={(e: KeyboardEvent) => props.onKeyDown?.(e)}
      >
        {props.children}
      </Tip>
      <Show when={props.onClose}>
        {(close) => (
          <Tip class="close" type="button" tip={props.closeLabel} aria-label={props.closeLabel} tabindex={-1} onClick={() => close()()}>
            <i class="i-lucide-x" aria-hidden="true" />
          </Tip>
        )}
      </Show>
    </div>
  );
}

/** Open files as tabs above the editor. Middle-click, the ×, Delete or Ctrl/Cmd+W closes a tab; arrows move between them. */
export function EditorTabs() {
  const { workspace: ws } = useContext(AppContext);
  // Same file name in two folders: those tabs show the folder too.
  const clashes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ws.state.open) counts.set(name(p), (counts.get(name(p)) ?? 0) + 1);
    return counts;
  });
  createEffect(
    () => ws.state.active,
    () => {
      document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  );

  return (
    <TabList id="tabs" class="tabs tablist" label="Open files" onSelect={(path) => path !== ws.state.active && ws.activate(path)}>
        {/* With no file open, an invisible tab holds the bar's height so the editor doesn't jump. */}
        <Show when={!ws.state.open.length}>
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
                if (matches("closeTab", e)) {
                  e.preventDefault();
                  ws.close(path);
                  // The focused tab is gone; keep keyboard focus in the bar, on the tab now selected.
                  flush();
                  document.querySelector<HTMLElement>('#tabs [aria-selected="true"]')?.focus();
                }
              }}
            >
              <span class="name">{name(path)}</span>
              {clashes().get(name(path))! > 1 && path.includes("/") && <span class="dir">{path.slice(0, path.lastIndexOf("/"))}</span>}
              <Show when={ws.state.dirty.includes(path)}>
                <Tip as="span" class="unsaved" tip="Unsaved changes" keys={keysFor("save").map(formatChord)} aria-label="unsaved">
                  ●
                </Tip>
              </Show>
            </TabItem>
          )}
        </For>
    </TabList>
  );
}
