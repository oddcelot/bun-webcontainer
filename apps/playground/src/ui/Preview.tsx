import { For, Show, createEffect, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Select } from "@runbun/ui/solid/Select";
import { TabItem, TabList } from "@runbun/ui/solid/Tabs";
import { isMac, matches } from "../keymap";
import { createPierre, createViewer } from "../editors/pierre";
import type { CodeEditor } from "../editors/types";
import { PREFIX, responseReserve, type Card } from "../preview";
import { AppContext } from "./context";
import type { PreviewTab } from "./previews";
import { Tip } from "@runbun/ui/solid/Tip";

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
 * The server path a link in a preview page opens in a new tab with (Cmd-click, Ctrl-click off macOS, or a middle
 * click), or undefined to let the click be. Same-origin links outside `/__preview` are the app's own paths, as the
 * service worker reads them (sw.ts leavePreview).
 */
function newTabPath(e: MouseEvent): string | undefined {
  const modified = e.button === 0 && (isMac ? e.metaKey : e.ctrlKey);
  if (e.defaultPrevented || !(modified || e.button === 1)) return;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.hasAttribute("download")) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  const path = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length) : url.pathname;
  return path + url.search;
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
            id="req-method"
            label="Method"
            tip={disabled ? CANT_RUN : "Method"}
            options={METHODS}
            value={active().method}
            onChange={(m) => m && p.edit(s.active, "method", m)}
            disabled={disabled}
            required
            placement="bottom-start"
            menuClass="method-menu"
            text={(m) => <MethodBadge method={m} />}
          />
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
              window.open(`${PREFIX}${path.startsWith("/") ? path : `/${path}`}`, "_blank", "noopener");
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
        <RequestBody hidden={active().method === "GET" || active().method === "HEAD"} empty={!active().body} body={active().body} />
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
                      const win = e.currentTarget.contentWindow;
                      win?.addEventListener("keydown", forwardKeys);
                      // A link opened "in a new tab" from a page opens a preview tab: a browser tab has no server.
                      // In the background, as browsers do; with Shift, switched to.
                      const openInTab = (e: MouseEvent) => {
                        const path = newTabPath(e);
                        if (path === undefined) return;
                        e.preventDefault();
                        const from = s.active;
                        p.request(p.open(path));
                        if (!e.shiftKey) p.activate(from);
                      };
                      win?.addEventListener("click", openInTab);
                      win?.addEventListener("auxclick", openInTab);
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
 *
 * A panel like the editor's: a tab bar with one tab, `Body` (the file tabs' TabList and TabItem), and the content type
 * the request will carry (preview.ts sendRequest: JSON when it parses, else text). Its editor is as tall as its lines
 * (at least one, at most 7em, then it scrolls), measured from the editor's lines as the embed measures the code
 * (embed/main.ts), so a one-line body leaves the response its room. Under it, a handle like the panes' (the
 * `.resize-handle` look, the embed's splitter's keys: arrows by 16px, Home, End; a double click fits again): a height
 * dragged there is kept for that tab and no longer fitted.
 *
 * The body only ever takes room from the response, never from the page: it stays between one line and what leaves
 * the response its reserve (preview.ts responseReserve), in the preview as it is, so a drag moves the line between
 * them and the embed keeps its size. Only a change to the body's lines (typing, another tab's or a preset's body) is
 * announced (`bodyfit`), for the embed's auto height to fit it (`data-fit`, the fitted height, not a dragged one);
 * when the preview itself changes size, the body is held within it again.
 */
function RequestBody(props: { hidden: boolean; empty: boolean; body: string }) {
  const { previews: p } = useContext(AppContext);
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  /** Heights readers dragged, by tab. */
  const dragged = new Map<number, number>();
  const [dragging, setDragging] = createSignal(false);
  const [height, setHeight] = createSignal(0);
  let lines: Element | null | undefined;
  /** One line, and the fitted height: the lines, up to 7em. */
  const metrics = () => {
    const code = el.querySelector(".pierre-host")?.firstElementChild?.shadowRoot?.querySelector<HTMLElement>("pre > code");
    const next = code?.querySelector("[data-content]");
    if (next !== lines) {
      if (lines) linesObserver.unobserve(lines);
      if ((lines = next)) linesObserver.observe(lines);
    }
    if (!code || !lines?.children.length) return;
    const count = lines.children.length;
    const box = getComputedStyle(code);
    const lh = lines.getBoundingClientRect().height / count;
    // The code's padding and horizontal scrollbar.
    const chrome = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom) + code.offsetHeight - code.clientHeight;
    const cap = parseFloat(getComputedStyle(el).fontSize) * 7;
    const line = Math.ceil(lh + chrome);
    const fitted = Math.ceil(Math.min(cap, count * lh + chrome));
    return { line, fitted };
  };
  /** The tallest the body may be in the preview as it is: itself and the response area, less the response's reserve. */
  const most = () => {
    const views = document.getElementById("preview-views");
    if (!views) return Infinity;
    return Math.floor(el.getBoundingClientRect().height + views.getBoundingClientRect().height - responseReserve());
  };
  /** The body at `target` px, held between one line and `most`; a no-op when that's its height already. */
  const apply = (target: number, line: number) => {
    const h = Math.round(Math.max(line, Math.min(target, most())));
    if (el.style.height === `${h}px`) return h;
    setHeight(h);
    el.style.height = `${h}px`;
    return h;
  };
  /** Its dragged height, else its fitted one; `announce`: its lines changed, so the embed's auto height may too. */
  const fit = (announce = false) => {
    if (props.hidden) return;
    const m = metrics();
    if (!m) return;
    el.dataset.fit = String(m.fitted);
    apply(dragged.get(untrack(() => p.state.active)) ?? m.fitted, m.line);
    if (announce) el.dispatchEvent(new Event("bodyfit", { bubbles: true }));
  };
  // Lines added or removed (typing, a preset's body), and the editor's first layout: fit again, and say so.
  const linesObserver = new ResizeObserver(() => fit(true));
  // The preview resized (the embed's auto height, a pane dragged, a fixed height): hold the body within it again.
  const wrapObserver = new ResizeObserver(() => fit());
  /** The body at `h` px (a drag, a key), within its bounds, kept for the active tab. */
  const drag = (h: number) => {
    const m = metrics();
    if (!m) return;
    dragged.set(untrack(() => p.state.active), apply(h, m.line));
  };
  createEffect(
    () => p.state.active,
    (id) => {
      editor ??= createPierre(el);
      const body = untrack(() => p.state.tabs.find((t) => t.id === id)?.body ?? "");
      editor.open(`request-body-${id}.json`, body, (text) => p.edit(id, "body", text));
      // After the editor has laid the body out.
      requestAnimationFrame(() => fit(true));
    },
  );
  // Shown again (a method with a body): fit what it holds now.
  createEffect(
    () => props.hidden,
    (hidden) => {
      if (!hidden) requestAnimationFrame(() => fit(true));
    },
  );
  onSettled(() => {
    const wrap = document.getElementById("preview-wrap");
    if (wrap) wrapObserver.observe(wrap);
    return () => {
      editor?.destroy();
      linesObserver.disconnect();
      wrapObserver.disconnect();
    };
  });
  // What sendRequest sends it as.
  const type = () => {
    if (!props.body) return "";
    try {
      JSON.parse(props.body);
      return "JSON";
    } catch {
      return "text";
    }
  };
  let start: { y: number; h: number } | undefined;
  return (
    <>
      <section id="req-body-panel" hidden={props.hidden} aria-label="Request body">
        <div class="tabs-bar">
          <TabList class="tabs tablist" label="Request" onSelect={() => el.querySelector<HTMLElement>(".pierre-host")?.focus()}>
            <TabItem value="body" selected title="The request's body">
              Body
            </TabItem>
          </TabList>
          <Show when={type()}>
            <span class="body-type" title={`Sent as ${type() === "JSON" ? "application/json" : "text/plain"}`}>
              {type()}
            </span>
          </Show>
        </div>
        <div id="req-body" ref={el} data-empty={props.empty ? "" : undefined} data-placeholder="Request body (JSON is sent as application/json)" />
      </section>
      <div
        id="req-handle"
        class="resize-handle"
        role="separator"
        tabindex="0"
        aria-label="Resize request body"
        aria-orientation="horizontal"
        aria-valuenow={height() || undefined}
        data-orientation="vertical"
        data-active={dragging() ? "" : undefined}
        data-dragging={dragging() ? "" : undefined}
        hidden={props.hidden}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start = { y: e.clientY, h: el.getBoundingClientRect().height };
          setDragging(true);
        }}
        onPointerMove={(e) => start && drag(start.h + e.clientY - start.y)}
        onPointerUp={() => {
          start = undefined;
          setDragging(false);
        }}
        onPointerCancel={() => {
          start = undefined;
          setDragging(false);
        }}
        onKeyDown={(e) => {
          const h = el.getBoundingClientRect().height;
          const next = { ArrowUp: h - 16, ArrowDown: h + 16, Home: 0, End: Infinity }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          drag(next);
        }}
        onDblClick={() => {
          // Fitted again, in the room there is: no announcement, so the embed keeps its size.
          dragged.delete(untrack(() => p.state.active));
          fit();
        }}
      />
    </>
  );
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
