import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { TabItem, TabList } from "@runbun/ui/solid/Tabs";
import { DOCK_TABS } from "./dockTabs";

/**
 * The pane under the preview: one of dockTabs.ts's panes at a time (the console, the debugger while Debug is on), with
 * tabs in its header once there is more than one to pick. With one, the header is that pane's name alone.
 */
export function Dock() {
  const [picked, setPicked] = createSignal(DOCK_TABS[0].id);
  const offered = createMemo(() => DOCK_TABS.filter((t) => !t.when || t.when()));
  // A picked tab that is no longer offered gives way to the first.
  const active = createMemo(() => (offered().find((t) => t.id === picked()) ?? offered()[0]).id);
  let before: unknown[] = [];
  createEffect(
    () => DOCK_TABS.map((t) => t.attention?.()),
    (now) => {
      const i = now.findIndex((a, n) => a && a !== before[n]);
      before = now;
      if (i >= 0) setPicked(DOCK_TABS[i].id);
    },
  );
  return (
    <>
      <div id="dock-head">
        <Show
          when={offered().length > 1}
          fallback={
            <>
              <i class={offered()[0].icon} aria-hidden="true" />
              <span class="label">{offered()[0].title}</span>
            </>
          }
        >
          <TabList class="tabs tablist" label="Panes under the preview" onSelect={setPicked}>
            <For each={offered()}>
              {(t) => (
                <TabItem value={t.id} selected={active() === t.id} title={t.tip}>
                  <i class={t.icon} aria-hidden="true" />
                  {t.title}
                </TabItem>
              )}
            </For>
          </TabList>
        </Show>
        {DOCK_TABS.map((t) => (
          <Show when={t.Head && active() === t.id}>{t.Head!()}</Show>
        ))}
      </div>
      {DOCK_TABS.map((t) => (
        <Show when={!t.when || t.when()}>
          <div class="dock-pane" id={`dock-pane-${t.id}`} role={offered().length > 1 ? "tabpanel" : undefined} aria-label={offered().length > 1 ? t.title : undefined} hidden={active() !== t.id}>
            {t.Body()}
          </div>
        </Show>
      ))}
    </>
  );
}
