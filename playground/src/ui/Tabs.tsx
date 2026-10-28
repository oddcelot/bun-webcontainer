import { For, createEffect, createMemo, flush, useContext } from "solid-js";
import { AppContext } from "./app";

const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Open files as tabs above the editor (rendered into EditorPane's #tabs tablist). Middle-click, the ×, Delete or Ctrl/Cmd+W closes a tab; arrows move between them. */
export function Tabs() {
  const { workspace: ws } = useContext(AppContext);
  const selected = () => document.querySelector<HTMLElement>('#tabs [aria-selected="true"]');
  // Same file name in two folders: those tabs show the folder too.
  const clashes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const p of ws.state.open) counts.set(name(p), (counts.get(name(p)) ?? 0) + 1);
    return counts;
  });
  createEffect(
    () => ws.state.active,
    () => {
      selected()?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  );

  function onKeyDown(e: KeyboardEvent, path: string) {
    if (e.key === "Delete" || (e.key === "w" && (e.ctrlKey || e.metaKey))) return e.preventDefault(), ws.close(path);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const open = ws.state.open;
    const next = open[open.indexOf(path) + (e.key === "ArrowLeft" ? -1 : 1)];
    if (!next) return;
    ws.activate(next);
    flush(); // so the newly selected tab is in the DOM as such
    selected()?.focus();
  }

  return (
    <For each={ws.state.open}>
      {(path) => (
        <div
          class="tab"
          role="tab"
          title={path}
          tabindex={ws.state.active === path ? 0 : -1}
          aria-selected={ws.state.active === path ? "true" : "false"}
          onClick={() => ws.activate(path)}
          onAuxClick={(e) => e.button === 1 && ws.close(path)}
          onKeyDown={(e) => onKeyDown(e, path)}
        >
          <span class="name">{name(path)}</span>
          {clashes().get(name(path))! > 1 && path.includes("/") && <span class="dir">{path.slice(0, path.lastIndexOf("/"))}</span>}
          <button
            class="close"
            title={`Close ${name(path)}`}
            aria-label={`Close ${name(path)}`}
            tabindex={-1}
            onClick={(e) => {
              e.stopPropagation();
              ws.close(path);
            }}
          >
            <i class="i-lucide-x" aria-hidden="true" />
          </button>
        </div>
      )}
    </For>
  );
}
