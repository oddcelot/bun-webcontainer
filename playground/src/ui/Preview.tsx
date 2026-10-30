import { For, Show, createEffect, onSettled, untrack, useContext } from "solid-js";
import { Select } from "@kobalte/core/select";
import { TabItem, TabList } from "./Tabs";
import { BASE } from "../base";
import { matches } from "../keymap";
import { createPierre, createViewer } from "../editors/pierre";
import type { CodeEditor } from "../editors/types";
import type { Card } from "../preview";
import { AppContext } from "./context";
import type { PreviewTab } from "./previews";
import { Tip } from "./Tip";

const CANT_RUN = "This browser can't run code here";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** An HTTP method as a tinted badge in its own color (style.css); DELETE reads DEL, in full for screen readers. */
function MethodBadge(props: { method: string }) {
  return (
    <span class="method-badge" data-method={props.method}>
      <Show when={props.method === "DELETE"} fallback={props.method}>
        <span aria-hidden="true">DEL</span>
        <span class="sr-only">DELETE</span>
      </Show>
    </span>
  );
}

/**
 * Keys pressed in a page stay in its frame, so a frame hands its key presses to the playground's window as well, for
 * the shortcuts there. A shortcut that's handled there doesn't also reach the page.
 */
function forwardKeys(e: KeyboardEvent) {
  const copy = new KeyboardEvent("keydown", e);
  dispatchEvent(copy);
  if (copy.defaultPrevented) e.preventDefault();
}

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

  const onKey = (e: KeyboardEvent) => {
    if (s.expanded && matches("exitFullscreen", e)) p.setExpanded(false);
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
        <div id="preview-tabs" class="tabs">
          <TabList class="tablist" label="Previews" onSelect={(id) => Number(id) !== s.active && p.activate(Number(id))}>
            <For each={s.tabs}>{(tab) => <PreviewTabItem tab={tab} />}</For>
          </TabList>
          <Tip class="add" type="button" tip="New preview" aria-label="New preview" onClick={() => p.request(p.open())}>
            <i class="i-lucide-plus" aria-hidden="true" />
          </Tip>
        </div>
        <form
          id="request"
          onSubmit={(e) => {
            e.preventDefault();
            p.request(s.active);
          }}
        >
          <Select<string>
            options={METHODS}
            value={active().method}
            onChange={(m) => m && p.edit(s.active, "method", m)}
            disabled={disabled}
            disallowEmptySelection
            placement="bottom-start"
            gutter={6}
            itemComponent={(props) => (
              <Select.Item item={props.item} class="select-option">
                <Select.ItemLabel class="name">
                  <MethodBadge method={props.item.rawValue} />
                </Select.ItemLabel>
              </Select.Item>
            )}
          >
            <Tip as={Select.Trigger} id="req-method" class="select-trigger" tip={disabled ? CANT_RUN : "Method"} aria-label="Method">
              <Select.Value<string> class="value">{(state) => <MethodBadge method={state.selectedOption()} />}</Select.Value>
              <Select.Icon class="chevron">
                <i class="i-lucide-chevron-down" aria-hidden="true" />
              </Select.Icon>
            </Tip>
            <Select.Portal>
              <Select.Content class="select-menu method-menu">
                <Select.Listbox class="select-list" />
              </Select.Content>
            </Select.Portal>
          </Select>
          <input
            id="req-path"
            spellcheck={false}
            title={disabled ? CANT_RUN : "Path on the running server"}
            disabled={disabled}
            value={active().path}
            onInput={(e) => p.edit(s.active, "path", e.currentTarget.value)}
          />
          <Tip type="submit" disabled={disabled} tip={disabled ? CANT_RUN : "Send the request"}>
            <i class="i-lucide-send" aria-hidden="true" />
            <span class="label">Send</span>
          </Tip>
          <Tip
            type="button"
            id="open-tab"
            tip={disabled ? CANT_RUN : "Open in a new tab (the server keeps running here)"}
            aria-label="Open in a new tab"
            disabled={disabled}
            onClick={() => {
              const path = active().path.trim() || "/";
              window.open(`${BASE}__preview${path.startsWith("/") ? path : `/${path}`}`, "_blank", "noopener");
            }}
          >
            <i class="i-lucide-external-link" aria-hidden="true" />
          </Tip>
          <Tip
            type="button"
            id="expand"
            tip={s.expanded ? "Restore preview" : "Expand preview"}
            keys={["Esc"]}
            aria-label={s.expanded ? "Restore preview" : "Expand preview"}
            aria-pressed={s.expanded ? "true" : "false"}
            onClick={() => p.setExpanded(!s.expanded)}
          >
            <i class={s.expanded ? "i-lucide-minimize-2" : "i-lucide-maximize-2"} aria-hidden="true" />
          </Tip>
        </form>
        <RequestBody hidden={active().method === "GET" || active().method === "HEAD"} empty={!active().body} />
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
                      e.currentTarget.contentWindow?.addEventListener("keydown", forwardKeys);
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

/**
 * The request body in the editor the files use, highlighted as JSON (what it's usually sent as). One editor: switching
 * preview tabs opens the active tab's body in it, and each edit goes back to that tab.
 */
function RequestBody(props: { hidden: boolean; empty: boolean }) {
  const { previews: p } = useContext(AppContext);
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  createEffect(
    () => p.state.active,
    (id) => {
      editor ??= createPierre(el);
      const body = untrack(() => p.state.tabs.find((t) => t.id === id)?.body ?? "");
      editor.open(`request-body-${id}.json`, body, (text) => p.edit(id, "body", text));
    },
  );
  onSettled(() => () => editor?.destroy());
  return <div id="req-body" ref={el} hidden={props.hidden} data-empty={props.empty ? "" : undefined} data-placeholder="Request body (JSON is sent as application/json)" />;
}

function PreviewTabItem(props: { tab: PreviewTab }) {
  const { previews: p } = useContext(AppContext);
  const closable = () => p.state.tabs.length > 1;
  return (
    <TabItem
      value={String(props.tab.id)}
      selected={props.tab.id === p.state.active}
      title={props.tab.title || `${props.tab.method} ${props.tab.path}`}
      onClose={closable() ? () => p.close(props.tab.id) : undefined}
      closeLabel={`Close ${props.tab.path}`}
    >
      <Show when={props.tab.method !== "GET"}>
        <MethodBadge method={props.tab.method} />
      </Show>
      <span class="name">{props.tab.path}</span>
    </TabItem>
  );
}

/** Response bodies above this many characters stay plain text: the viewer renders every line. */
const MAX_HIGHLIGHTED = 200_000;

/** The extension to highlight a response body as, or undefined to show it as plain text (red when it failed). */
function highlight(card: Card): string | undefined {
  if (card.text.length > MAX_HIGHLIGHTED) return undefined;
  const type = card.type;
  const known: [RegExp, string][] = [
    [/[/+]json\b/, "json"],
    [/\bhtml\b/, "html"],
    [/\bcss\b/, "css"],
    [/\b(?:java|ecma)script\b/, "js"],
    [/[/+]xml\b/, "xml"],
    [/\bmarkdown\b/, "md"],
  ];
  return known.find(([re]) => re.test(type))?.[1];
}

/** A response body, highlighted in its language (from the extension of `name`), read-only. */
function ResponseBody(props: { name: string; text: string }) {
  let el!: HTMLDivElement;
  let viewer: ReturnType<typeof createViewer> | undefined;
  createEffect(
    () => [props.name, props.text] as const,
    ([name, text]) => {
      viewer ??= createViewer(el);
      viewer.show(name, text);
    },
  );
  onSettled(() => () => viewer?.destroy());
  return <div class="body highlighted" ref={el} />;
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
              <Show when={highlight(card())} fallback={<pre class="body">{card().text}</pre>}>
                {(ext) => <ResponseBody name={`response.${ext()}`} text={card().text} />}
              </Show>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
