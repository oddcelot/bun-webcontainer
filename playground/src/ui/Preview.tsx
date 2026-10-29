import { For, Show, createEffect, onSettled, untrack, useContext } from "solid-js";
import type { Card } from "../preview";
import { AppContext } from "./context";
import type { PreviewTab } from "./previews";

const CANT_RUN = "This browser can't run code here";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Request bar over the preview: any method and path against the running server. HTML GETs load in the iframe
 * (so pages, scripts and links work); everything else shows status, headers and body. Several previews can be
 * open as tabs; the request bar acts on the active one.
 */
export function Preview() {
  const app = useContext(AppContext);
  const p = app.previews;
  const s = p.state;
  const active = () => s.tabs.find((t) => t.id === s.active)!;
  // iframes in the order they were opened: moving an iframe in the DOM reloads it.
  const byAge = () => [...s.tabs].sort((a, b) => a.id - b.id);
  const disabled = !app.session.canRun;

  // Keys pressed in a page stay in its frame; frames forward Escape here too (see onLoad).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && s.expanded) p.setExpanded(false);
  };
  onSettled(() => {
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  createEffect(
    () => s.active,
    () => {
      document.querySelector('#preview-tabs [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  );

  return (
    <>
      <div id="preview-backdrop" hidden={!s.expanded} onClick={() => p.setExpanded(false)} />
      <div id="preview-wrap" class={{ expanded: s.expanded }}>
        <div id="preview-tabs" class="tabs" role="tablist" aria-label="Previews">
          <For each={s.tabs}>{(tab) => <PreviewTabItem tab={tab} />}</For>
          <button class="add" type="button" title="New preview" aria-label="New preview" onClick={() => p.request(p.open())}>
            <i class="i-lucide-plus" aria-hidden="true" />
          </button>
        </div>
        <form
          id="request"
          onSubmit={(e) => {
            e.preventDefault();
            p.request(s.active);
          }}
        >
          <select
            id="req-method"
            title={disabled ? CANT_RUN : "Method"}
            disabled={disabled}
            value={active().method}
            onChange={(e) => p.edit(s.active, "method", e.currentTarget.value)}
          >
            <For each={METHODS}>{(m) => <option>{m}</option>}</For>
          </select>
          <input
            id="req-path"
            spellcheck={false}
            title={disabled ? CANT_RUN : "Path on the running server"}
            disabled={disabled}
            value={active().path}
            onInput={(e) => p.edit(s.active, "path", e.currentTarget.value)}
          />
          <button disabled={disabled} title={disabled ? CANT_RUN : "Send"}>
            <i class="i-lucide-send" aria-hidden="true" />
            <span class="label">Send</span>
          </button>
          <button
            type="button"
            id="expand"
            title={s.expanded ? "Restore preview (Esc)" : "Expand preview (Esc)"}
            aria-pressed={s.expanded ? "true" : "false"}
            onClick={() => p.setExpanded(!s.expanded)}
          >
            <i class={s.expanded ? "i-lucide-minimize-2" : "i-lucide-maximize-2"} aria-hidden="true" />
          </button>
        </form>
        <textarea
          id="req-body"
          spellcheck={false}
          placeholder="Request body (JSON is sent as application/json)"
          hidden={active().method === "GET" || active().method === "HEAD"}
          value={active().body}
          onInput={(e) => p.edit(s.active, "body", e.currentTarget.value)}
        />
        <div id="preview-views">
          <For each={byAge()}>
            {(tab) => {
              // A tab's id never changes; read it once for the frame registry and its load handler.
              const id = untrack(() => tab.id);
              return (
                <>
                  <iframe
                    class="preview-frame"
                    title="preview"
                    hidden={id !== s.active || tab.view !== "frame"}
                    ref={(el) => p.frames.set(id, el)}
                    onLoad={(e) => {
                      p.loaded(id, e.currentTarget);
                      e.currentTarget.contentWindow?.addEventListener("keydown", onKey);
                    }}
                  />
                  <Response card={tab.response} hidden={id !== s.active || tab.view !== "response"} />
                </>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

function PreviewTabItem(props: { tab: PreviewTab }) {
  const { previews: p } = useContext(AppContext);
  const selected = () => props.tab.id === p.state.active;
  const closable = () => p.state.tabs.length > 1;
  return (
    <div
      class="tab"
      role="tab"
      title={props.tab.title || `${props.tab.method} ${props.tab.path}`}
      tabindex={selected() ? 0 : -1}
      aria-selected={selected() ? "true" : "false"}
      onClick={() => p.activate(props.tab.id)}
      onAuxClick={(e) => e.button === 1 && closable() && p.close(props.tab.id)}
    >
      <Show when={props.tab.method !== "GET"}>
        <span class="method">{props.tab.method}</span>
      </Show>
      <span class="name">{props.tab.path}</span>
      <Show when={closable()}>
        <button
          class="close"
          title={`Close ${props.tab.path}`}
          aria-label={`Close ${props.tab.path}`}
          tabindex={-1}
          onClick={(e) => {
            e.stopPropagation();
            p.close(props.tab.id);
          }}
        >
          <i class="i-lucide-x" aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
}

/** The response card: status pill and request line, headers, then the body in a box (red when it failed). */
function Response(props: { card: Card | null; hidden: boolean }) {
  return (
    <div class={["preview-response", { error: props.card ? !props.card.ok : false }]} hidden={props.hidden}>
      <Show when={props.card}>
        {(card) => (
          <>
            <div class="status-line">
              <Show when={card().status}>
                <span class="status">{card().status}</span>
              </Show>
              <span class="line">{card().line}</span>
            </div>
            <Show when={card().head}>
              <pre class="headers">{card().head}</pre>
            </Show>
            <Show when={card().text}>
              <pre class="body">{card().text}</pre>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
