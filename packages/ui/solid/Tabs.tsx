import { Show, onSettled, type ParentProps } from "solid-js";
import { Tip } from "./Tip";
import "../css/tabs.css";

/**
 * A row of tabs (role tablist), each a `TabItem`. Selection is the caller's: a click, or the arrow keys, Home and End
 * (which move focus and select, without wrapping), call `onSelect` with the tab's value. The selected tab is the one
 * Tab-key focus lands on. The row scrolls sideways with no scrollbar, so a vertical wheel scrolls it too.
 */
export function TabList(props: ParentProps<{ id?: string; class?: string; label: string; onSelect: (value: string) => void }>) {
  const tabs = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  const select = (tab: HTMLElement | undefined) => tab && props.onSelect(tab.dataset.value!);
  let list!: HTMLDivElement;
  let indicator!: HTMLSpanElement;
  onSettled(() => followSelected(list, indicator));
  return (
    <div
      ref={list}
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
      <span ref={indicator} class="tab-indicator" aria-hidden="true" hidden />
      {props.children}
    </div>
  );
}

/**
 * The selected tab's look (tabs.css .tab-indicator): one element under the tabs, moved to the selected tab and sized
 * to it whenever the tabs, their sizes or the row change. It jumps rather than slides the first time and after the row
 * was hidden; with no tab selected it hides. Returns the cleanup.
 */
function followSelected(list: HTMLElement, indicator: HTMLElement) {
  let shown = false;
  const place = () => {
    const tab = list.querySelector<HTMLElement>(":scope > .tab[data-selected]");
    if (!tab?.offsetWidth) {
      indicator.hidden = true;
      shown = false;
      return;
    }
    if (!shown) indicator.style.transition = "none";
    indicator.hidden = false;
    indicator.style.width = `${tab.offsetWidth}px`;
    indicator.style.height = `${tab.offsetHeight}px`;
    indicator.style.translate = `${tab.offsetLeft}px ${tab.offsetTop}px`;
    if (!shown) {
      // Laid out where it lands before the transition comes back, so it doesn't slide there.
      void indicator.offsetWidth;
      indicator.style.transition = "";
    }
    shown = true;
  };
  // Each tab's size (a label, a dirty dot, a font loading) and the row's; tabs coming, going, moving or selected.
  const sizes = new ResizeObserver(place);
  const watch = () => {
    sizes.disconnect();
    sizes.observe(list);
    for (const tab of list.querySelectorAll(":scope > .tab")) sizes.observe(tab);
  };
  const changes = new MutationObserver(() => (watch(), place()));
  changes.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-selected"] });
  watch();
  place();
  return () => (sizes.disconnect(), changes.disconnect());
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
