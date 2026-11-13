import { For, Show, createEffect, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Select } from "@runbun/ui/solid/Select";
import { Menu, MenuItem, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { TabItem, TabList } from "@runbun/ui/solid/Tabs";
import { chordKeys, isMac, keysFor, matches, recordingKeys } from "../keymap";
import { createPierre, createViewer } from "../editors/pierre";
import type { CodeEditor } from "../editors/types";
import { CONTENT_ORIGIN } from "../contentOrigin";
import { onFrameMessage } from "../previewBridge";
import { BODY_ROOM_LINES, normalize, previewUrl, responseReserve, PREFIX, type Card } from "../preview";
import { AppContext } from "./context";
import { draftKey, hasBody, type PreviewTab, type Rows, type Section } from "./previews";
import { fromAuth, paramRows, queryOf, sent, toCurl, toFetch, toHttp, type Auth, type BodyMode, type Field } from "../request";
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
  /**
   * Send's keys, anywhere: on window, on the way down and stopped there, so an editor doesn't take them first (as
   * App.tsx does with its shortcuts). Not while the shortcuts dialog records keys.
   */
  const onGlobalSendKey = (e: KeyboardEvent) => {
    if (disabled || recordingKeys() || !matches("send", e)) return;
    e.preventDefault();
    e.stopPropagation();
    p.request(s.active);
  };
  onSettled(() => {
    addEventListener("keydown", onGlobalSendKey, { capture: true });
    return () => removeEventListener("keydown", onGlobalSendKey, { capture: true });
  });
  // On the content origin the preview documents report through their bridge (previewBridge.ts).
  onSettled(() => {
    if (!CONTENT_ORIGIN) return;
    const onMessage = (e: MessageEvent) => onFrameMessage(e, p);
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  });
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
        {/* An embed without tabs has no bar for a single preview either; several (`requests`) keep theirs. */}
        <Show when={(app.features?.has("tabs") ?? true) || s.tabs.length > 1}>
          <div id="preview-tabs" class="tabs">
            <TabList class="tablist" label="Previews" onSelect={(id) => Number(id) !== s.active && p.activate(Number(id))}>
              <For each={s.tabs}>{(tab) => <PreviewTabItem tab={tab} />}</For>
            </TabList>
            <Tip class="add" type="button" tip="New preview" aria-label="New preview" onClick={() => p.request(p.open())}>
              <i class="i-lucide-plus" aria-hidden="true" />
            </Tip>
          </div>
        </Show>
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
          <Tip
            type="button"
            id="req-panel-toggle"
            tip={`${active().panel ? "Hide" : "Show"} the request panel${panelSummary(active()) ? ` (${panelSummary(active())})` : ""}`}
            aria-label="Request panel"
            aria-controls="req-panel"
            aria-pressed={active().panel ? "true" : "false"}
            disabled={disabled}
            onClick={() => p.panel(s.active)}
          >
            <i class="i-lucide-sliders-horizontal" aria-hidden="true" />
            <Show when={queryOf(active().path).length + sent(active().headers).length + (Object.keys(fromAuth(active().auth)).length ? 1 : 0)}>
              {(n) => <span class="count">{n()}</span>}
            </Show>
          </Tip>
          <Tip
            type="submit"
            id="req-send"
            disabled={disabled}
            tip={disabled ? CANT_RUN : "Send the request"}
            keys={disabled ? undefined : keysFor("send").map(chordKeys)}
            aria-label="Send the request"
          >
            <i class="i-lucide-send" aria-hidden="true" />
          </Tip>
          <Tip
            type="button"
            id="open-tab"
            tip={disabled ? CANT_RUN : "Open in a new tab"}
            aria-label="Open in a new tab"
            disabled={disabled}
            onClick={() => {
              const path = active().path.trim() || "/";
              window.open(previewUrl(path.startsWith("/") ? path : `/${path}`), "_blank", "noopener");
            }}
          >
            <i class="i-lucide-external-link" aria-hidden="true" />
          </Tip>
          <Tip
            type="button"
            id="expand"
            tip={s.expanded ? "Restore preview" : "Expand preview"}
            // Only restoring has keys (the keymap's, Esc unless rebound): nothing expands it but the button.
            keys={s.expanded ? keysFor("exitFullscreen").map(chordKeys) : undefined}
            aria-label={s.expanded ? "Restore preview" : "Expand preview"}
            aria-pressed={s.expanded ? "true" : "false"}
            onClick={() => p.setExpanded(!s.expanded)}
          >
            <i class={s.expanded ? "i-lucide-minimize-2" : "i-lucide-maximize-2"} aria-hidden="true" />
          </Tip>
        </form>
        <RequestPanel tab={active()} />
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
                    allow={CONTENT_ORIGIN ? `cross-origin-isolated ${CONTENT_ORIGIN}` : undefined}
                    hidden={id !== s.active || tab.view !== "frame"}
                    ref={(el) => p.frames.set(id, el)}
                    onLoad={(e) => {
                      // On the content origin the page's window is cross-origin: its bridge does all of this (previewBridge.ts).
                      if (CONTENT_ORIGIN) return;
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
                  <Response card={tab.response} hidden={id !== s.active || tab.view !== "response"} stale={!!tab.response && tab.sentKey !== draftKey(tab)} />
                </>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

/** What the toggle's count adds up: "2 params, 1 header, auth". */
function panelSummary(tab: PreviewTab): string {
  const n = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? "" : "s"}` : "");
  return [n(queryOf(tab.path).length, "param"), n(sent(tab.headers).length, "header"), Object.keys(fromAuth(tab.auth)).length ? "auth" : ""].filter(Boolean).join(", ");
}

/** Header names offered as a header row's name is typed. */
const HEADER_NAMES = ["Accept", "Accept-Language", "Authorization", "Cache-Control", "Content-Type", "Cookie", "If-None-Match", "Origin", "Referer", "User-Agent", "X-Requested-With"];

/** The body modes, as the Body section's picker lists them, with the content type each is sent as. */
const BODY_MODES: { mode: BodyMode; label: string; tip: string }[] = [
  { mode: "json", label: "JSON", tip: "application/json" },
  { mode: "text", label: "Text", tip: "text/plain" },
  { mode: "form", label: "Form", tip: "application/x-www-form-urlencoded" },
  { mode: "multipart", label: "Multipart", tip: "multipart/form-data, with files from the project" },
];

const AUTH_TYPES: { type: Auth["type"]; label: string }[] = [
  { type: "none", label: "None" },
  { type: "bearer", label: "Bearer token" },
  { type: "basic", label: "Basic" },
  { type: "apikey", label: "API key" },
];

/**
 * Name and value rows (the query's parameters, headers, a form's fields), with one empty row after them to add one:
 * typing in it makes it a row (`onChange` with the index one past the last) and another empty one appears under it.
 * Rows go by index, so the field being typed in stays put. With `toggles`, each row has a checkbox to turn it off
 * (the empty row's is dimmed, so the column reads as one);
 * with `files`, a button that makes its value a path to a project file (offered from the `files` datalist, read when
 * its value is focused: `onFiles`). `derived` is a read-only row first, one Auth writes; clicking it opens Auth.
 */
function Fields(props: {
  label: string;
  rows: readonly Field[];
  toggles?: boolean;
  names?: string;
  files?: boolean;
  onFiles?: () => void;
  /** Whether a file row's path is a project file: one that isn't is marked. */
  fileExists?: (path: string) => boolean;
  derived?: { name: string; value: string; open: () => void };
  hidden: boolean;
  onChange: (i: number, change: Partial<Field>) => void;
  onRemove: (i: number) => void;
}) {
  const all = () => [...props.rows, { name: "", value: "", on: true } as Field];
  return (
    <div class="fields" role="group" aria-label={props.label} hidden={props.hidden}>
      <Show when={props.derived}>
        {(d) => (
          <button type="button" class="field derived" title="Set in Auth. Click to edit" onClick={() => d().open()}>
            <i class="i-lucide-lock" aria-hidden="true" />
            <span class="name">{d().name}</span>
            <span class="value">{d().value}</span>
            <span class="from">
              Edit in Auth <i class="i-lucide-arrow-right" aria-hidden="true" />
            </span>
          </button>
        )}
      </Show>
      <For each={all()} keyed={false}>
        {(row, i) => (
          <div class="field" data-new={i === props.rows.length ? "" : undefined}>
            <Show when={props.toggles}>
              <input
                type="checkbox"
                checked={row().on !== false && i < props.rows.length}
                disabled={i === props.rows.length}
                aria-label={`Send ${row().name || `row ${i + 1}`}`}
                onChange={(e) => props.onChange(i, { on: e.currentTarget.checked })}
              />
            </Show>
            <input
              class="name"
              spellcheck={false}
              autocomplete="off"
              placeholder={i === props.rows.length ? "Add name" : "Name"}
              list={props.names}
              aria-label={`${props.label}: name ${i + 1}`}
              value={row().name}
              onInput={(e) => props.onChange(i, { name: e.currentTarget.value })}
            />
            <input
              class="value"
              spellcheck={false}
              autocomplete="off"
              placeholder={row().file ? "Path of a project file" : "Value"}
              list={row().file ? "project-files" : undefined}
              data-file={row().file ? "" : undefined}
              aria-invalid={row().file && row().value.trim() && props.fileExists && !props.fileExists(row().value) ? "true" : undefined}
              title={row().file && row().value.trim() && props.fileExists && !props.fileExists(row().value) ? "No such file in the project" : undefined}
              aria-label={`${props.label}: ${row().file ? "file" : "value"} ${i + 1}`}
              value={row().value}
              onFocus={() => row().file && props.onFiles?.()}
              onInput={(e) => props.onChange(i, { value: e.currentTarget.value })}
            />
            <Show when={props.files}>
              <Tip
                type="button"
                class="kind"
                tip={row().file ? "Send text instead" : "Send a project file"}
                aria-label={`${row().file ? "Text" : "File"} for ${row().name || `row ${i + 1}`}`}
                aria-pressed={row().file ? "true" : "false"}
                onClick={() => {
                  props.onChange(i, { file: !row().file });
                  if (!row().file) props.onFiles?.();
                }}
              >
                <i class="i-lucide-paperclip" aria-hidden="true" />
              </Tip>
            </Show>
            <Tip
              type="button"
              class="remove"
              tip="Remove"
              aria-label={`Remove ${row().name || `row ${i + 1}`}`}
              hidden={i === props.rows.length}
              onClick={() => props.onRemove(i)}
            >
              <i class="i-lucide-x" aria-hidden="true" />
            </Tip>
          </div>
        )}
      </For>
    </div>
  );
}

/** What Auth sends, for its tab's tooltip. */
function authSummary(auth: Auth): string {
  const set = fromAuth(auth);
  const type = AUTH_TYPES.find((a) => a.type === auth.type)?.label ?? "";
  if (auth.type === "none") return "Authorization: none";
  if (!set.header && !set.param) return `${type}: nothing to send yet`;
  return set.header ? `${type}, sent as the ${set.header[0]} header` : `${type}, sent as ?${set.param!.name}=`;
}

/** The Auth section: a type, and its fields (a token, a user and password, or an API key's name, value and place). */
function AuthFields(props: { auth: Auth; hidden: boolean; onChange: (change: Partial<Auth>) => void }) {
  const input = (key: "token" | "user" | "pass" | "key" | "value", label: string, type = "text") => (
    <input
      class={key === "key" ? "name" : "value"}
      type={type}
      spellcheck={false}
      autocomplete="off"
      placeholder={label}
      aria-label={label}
      value={props.auth[key]}
      onInput={(e) => props.onChange({ [key]: e.currentTarget.value })}
    />
  );
  return (
    <div class="fields auth" role="group" aria-label="Auth" hidden={props.hidden}>
      <div class="field">
        <Select<(typeof AUTH_TYPES)[number]>
          class="auth-type"
          label="Auth type"
          options={AUTH_TYPES}
          optionValue="type"
          optionTextValue="label"
          value={AUTH_TYPES.find((a) => a.type === props.auth.type) ?? null}
          onChange={(a) => a && props.onChange({ type: a.type })}
          required
          placement="bottom-start"
        />
        <Show when={props.auth.type === "bearer"}>{input("token", "Token")}</Show>
        <Show when={props.auth.type === "basic"}>
          {input("user", "Username")}
          {input("pass", "Password", "password")}
        </Show>
        <Show when={props.auth.type === "apikey"}>
          {input("key", "Name, e.g. X-API-Key")}
          {input("value", "Key")}
          <Select<"header" | "query">
            class="auth-in"
            label="Send the key in"
            options={["header", "query"]}
            value={props.auth.in}
            onChange={(v) => v && props.onChange({ in: v })}
            text={(v) => (v === "header" ? "Header" : "Query")}
            required
            placement="bottom-end"
          />
        </Show>
        <Show when={props.auth.type === "none"}>
          <span class="hint">Pick a type to add auth</span>
        </Show>
      </div>
    </div>
  );
}

/**
 * The request panel under the request bar, shown with its toggle there (and when a method that takes a body is
 * picked): Params (the path's query as rows, written back to the path as they change, and read from it as it's
 * typed), Headers (sent through the service worker, so `Cookie` and the like reach the server too: request.ts), Auth
 * (a header, or an API key's query parameter, written when sent and shown read-only in Headers or Params) and Body:
 * the editor's text as JSON or text, or rows as a form (urlencoded, or multipart with project files), picked above it;
 * for a method without one, a note and a way to switch to POST. The four tabs stay put for every method. A tab shows
 * how many rows it sends (Params, Headers) or a dot once it sends anything (Auth, Body). Raw, a toggle at the right of
 * the tab bar, shows the whole request as `.http` text (request.ts toHttp, fromHttp) in place of the section, read
 * back as it's typed (and said to screen readers once typing pauses).
 *
 * Rows are as tall as they are, up to a few, then scroll. The tab bar is the file tabs' TabList and TabItem (drawn
 * lighter here: style.css), with Raw and a menu that copies the request as curl or `fetch`, for the app run locally,
 * at its end.
 *
 * The body and the Raw view are in the editor the files use, the body highlighted as JSON (what it's usually sent as).
 * One editor: switching preview tabs (or between Body and Raw) opens the active tab's text in it, and each edit goes
 * back to that tab. It is as tall as its lines (at
 * least one, at most 7em (12em for Raw), then it scrolls), measured from the editor's lines as the embed measures the code
 * (embed/main.ts), so a one-line body leaves the response its room. Under it, a handle like the panes' (the
 * `.resize-handle` look, the embed's splitter's keys: arrows by 16px, Home, End; a double click fits again): a height
 * dragged there is kept for that tab and no longer fitted.
 *
 * The body only ever takes room from the response, never from the page: it stays between one line and what leaves
 * the response its reserve (preview.ts responseReserve), in the preview as it is, so a drag moves the line between
 * them and the embed keeps its size. A change to the body's lines (typing, another tab's or a preset's body), and the
 * panel shown, hidden, on another section or with rows added or removed, is announced (`bodyfit`), for the embed's
 * auto height to fit it (`data-fit`, the body's fitted height, not a dragged one); when the preview itself changes
 * size, the body is held within it again.
 */
function RequestPanel(props: { tab: PreviewTab }) {
  const { previews: p } = useContext(AppContext);
  const section = () => props.tab.section;
  const raw = () => props.tab.raw;
  const withBody = () => hasBody(props.tab.method);
  const params = () => queryOf(props.tab.path);
  const rowsMode = () => props.tab.bodyMode === "form" || props.tab.bodyMode === "multipart";
  /** The editor shows the body (as JSON or text) and the Raw view. */
  const editorHidden = () => !props.tab.panel || !(raw() || (section() === "body" && withBody() && !rowsMode()));
  /** The rows sections show (not while Raw shows them all as text). */
  const shows = (s: Section) => !raw() && section() === s;
  const auth = () => fromAuth(props.tab.auth);
  const app = useContext(AppContext);
  /** The project's files, for a multipart file row (read when one is focused or made). */
  const [files, setFiles] = createSignal<string[]>([]);
  const readFiles = () => setFiles(app.vfs.list().filter((f) => !f.startsWith("node_modules/")));
  const rows = (list: Rows) => ({
    onChange: (i: number, c: Partial<Field>) => p.row(p.state.active, list, i, c),
    onRemove: (i: number) => p.removeRow(p.state.active, list, i),
  });
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  /** Heights readers dragged, by tab. */
  const dragged = new Map<number, number>();
  const [dragging, setDragging] = createSignal(false);
  const [height, setHeight] = createSignal(0);
  let lines: Element | null | undefined;
  /** One line, the fitted height (the lines, up to 7em), and BODY_ROOM_LINES' height (up to the same). */
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
    // The Raw view holds the request line and headers too.
    const cap = parseFloat(getComputedStyle(el).fontSize) * (untrack(raw) ? 12 : 7);
    const line = Math.ceil(lh + chrome);
    const fitted = Math.ceil(Math.min(cap, count * lh + chrome));
    const room = Math.ceil(Math.min(cap, Math.max(count, BODY_ROOM_LINES) * lh + chrome));
    return { line, fitted, room };
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
    if (editorHidden()) return;
    const m = metrics();
    if (!m) return;
    el.dataset.fit = String(m.fitted);
    el.dataset.room = String(m.room);
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
    () => [p.state.active, raw() ? "http" : props.tab.bodyMode === "text" ? "txt" : "json"] as const,
    ([id, ext]) => {
      editor ??= createPierre(el);
      const text = untrack(() => {
        const tab = p.state.tabs.find((t) => t.id === id);
        return !tab ? "" : ext === "http" ? toHttp(tab) : tab.body;
      });
      if (ext === "http")
        editor.open(`request-${id}.http`, text, (text) => {
          p.raw(id, text);
          announceRaw();
        });
      else editor.open(`request-body-${id}.${ext}`, text, (text) => p.edit(id, "body", text));
      // After the editor has laid the body out.
      requestAnimationFrame(() => fit(true));
    },
  );
  // The Raw view follows changes made elsewhere (the request bar, another section) while it isn't being typed in;
  // while it is, it is what the request is read from.
  createEffect(
    () => (raw() ? toHttp(props.tab) : null),
    (text) => {
      if (text === null || !editor || el.contains(document.activeElement) || editor.getText() === text) return;
      editor.update(text);
    },
  );
  // What Raw set, said once typing pauses: the sections it changes aren't on screen.
  const [said, setSaid] = createSignal("");
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  const announceRaw = () => {
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      const t = untrack(() => props.tab);
      const n = sent(t.headers).length;
      setSaid(`Request read from Raw: ${t.method} ${t.path}, ${n} header${n === 1 ? "" : "s"}`);
    }, 800);
  };
  /** The JSON body, if it parses, pretty-printed with two spaces; undefined if it doesn't. */
  const formattedJson = () => {
    try {
      return JSON.stringify(JSON.parse(props.tab.body), null, 2);
    } catch {
      return undefined;
    }
  };
  /** Format the JSON body as one undoable edit; a body that isn't JSON stays as it is. */
  const formatBody = () => {
    const text = formattedJson();
    if (text !== undefined) editor?.replace(text);
  };
  const [copied, setCopied] = createSignal("");
  const copy = (kind: "curl" | "fetch") => {
    const draft = { ...props.tab, path: normalize(props.tab.path.trim() || "/") };
    void navigator.clipboard.writeText(kind === "curl" ? toCurl(draft) : toFetch(draft)).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    });
  };
  // The body shown again: fit what it holds now. The panel shown, hidden, on another section or with rows added or
  // removed: say so, for the embed's auto height.
  createEffect(
    () =>
      [
        editorHidden(),
        props.tab.panel,
        section(),
        raw(),
        withBody(),
        props.tab.bodyMode,
        props.tab.auth.type,
        params().length,
        props.tab.offParams.length,
        props.tab.headers.length,
        props.tab.form.length,
        props.tab.multipart.length,
      ] as const,
    ([hidden]) => {
      requestAnimationFrame(() => (hidden ? el.dispatchEvent(new Event("bodyfit", { bubbles: true })) : fit(true)));
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
  let start: { y: number; h: number } | undefined;
  return (
    <>
      <section id="req-panel" hidden={!props.tab.panel} aria-label="Request" data-raw={raw() ? "" : undefined}>
        <div class="tabs-bar">
          <TabList class="tabs tablist" label="Request" onSelect={(v) => p.panel(p.state.active, v as Section)}>
            <TabItem value="params" selected={section() === "params"} title="The path's query parameters">
              Params
              <Show when={params().length}>{(n) => <span class="count">{n()}</span>}</Show>
            </TabItem>
            <TabItem value="headers" selected={section() === "headers"} title="Headers sent with the request">
              Headers
              <Show when={sent(props.tab.headers).length}>{(n) => <span class="count">{n()}</span>}</Show>
            </TabItem>
            <TabItem value="auth" selected={section() === "auth"} title={authSummary(props.tab.auth)}>
              Auth
              <Show when={Object.keys(auth()).length}>
                <span class="dot" aria-label="set" />
              </Show>
            </TabItem>
            <TabItem value="body" selected={section() === "body"} title={withBody() ? "The request's body" : `${props.tab.method} requests have no body`}>
              Body
              <Show when={withBody() && (rowsMode() ? (props.tab.bodyMode === "form" ? sent(props.tab.form) : sent(props.tab.multipart)).length > 0 : !!props.tab.body)}>
                <span class="dot" aria-label="set" />
              </Show>
            </TabItem>
          </TabList>
          <span class="panel-tools">
            <Tip
              type="button"
              class="raw-toggle"
              tip={raw() ? "Back to the fields" : "Edit the whole request as text (.http)"}
              aria-pressed={raw() ? "true" : "false"}
              onClick={() => p.toggleRaw(p.state.active)}
            >
              <i class="i-lucide-file-code-2" aria-hidden="true" />
              <span class="label">Raw</span>
            </Tip>
            <Menu
              placement="bottom-end"
              trigger={
                <Tip as={MenuTrigger} class="copy-request" tip={copied() ? "Copied" : "Copy request"} aria-label="Copy the request">
                  <i class={copied() ? "i-lucide-check" : "i-lucide-copy"} aria-hidden="true" />
                </Tip>
              }
            >
              <MenuItem icon="i-lucide-terminal" label="Copy as curl" onSelect={() => copy("curl")} />
              <MenuItem icon="i-lucide-braces" label="Copy as fetch" onSelect={() => copy("fetch")} />
            </Menu>
          </span>
        </div>
        <span class="sr-only" aria-live="polite">
          {said()}
        </span>
        <Fields
          label="Query parameters"
          rows={paramRows(props.tab.path, props.tab.offParams)}
          toggles
          derived={auth().param && { ...auth().param!, open: () => p.panel(p.state.active, "auth") }}
          hidden={!shows("params")}
          onChange={(i, c) => p.param(p.state.active, i, c)}
          onRemove={(i) => p.removeParam(p.state.active, i)}
        />
        <Fields
          label="Headers"
          rows={props.tab.headers}
          toggles
          names="header-names"
          derived={auth().header && { name: auth().header![0], value: auth().header![1], open: () => p.panel(p.state.active, "auth") }}
          hidden={!shows("headers")}
          {...rows("headers")}
        />
        <AuthFields auth={props.tab.auth} hidden={!shows("auth")} onChange={(c) => p.auth(p.state.active, c)} />
        <div class="body-bar" hidden={!shows("body") || !withBody()}>
          <Segmented
            label="Body sent as"
            value={props.tab.bodyMode}
            options={BODY_MODES.map((m) => [m.mode, m.label, undefined, `Sent as ${m.tip}`])}
            onChange={(m) => p.bodyMode(p.state.active, m as BodyMode)}
          />
          <Show when={props.tab.bodyMode === "json"}>
            {/* aria-disabled, not disabled: a disabled button gets no pointer events, so no tooltip saying why. */}
            <Tip
              type="button"
              class="format-body"
              aria-disabled={formattedJson() === undefined ? "true" : undefined}
              tip={!props.tab.body.trim() ? "Nothing to format yet" : formattedJson() === undefined ? "Not valid JSON" : "Indent the JSON body"}
              keys={keysFor("format").map(chordKeys)}
              onClick={formatBody}
            >
              <i class="i-lucide-wand-sparkles" aria-hidden="true" /> Format
            </Tip>
          </Show>
        </div>
        <div class="no-body" hidden={!shows("body") || withBody()}>
          <span>{props.tab.method} requests have no body.</span>
          <button type="button" onClick={() => p.edit(p.state.active, "method", "POST")}>
            Switch to POST
          </button>
        </div>
        <Fields label="Form fields" rows={props.tab.form} toggles hidden={!shows("body") || !withBody() || props.tab.bodyMode !== "form"} {...rows("form")} />
        <Fields
          label="Multipart fields"
          rows={props.tab.multipart}
          toggles
          files
          onFiles={readFiles}
          fileExists={(path) => app.vfs.read(path.trim().replace(/^\/+/, "")) !== undefined}
          hidden={!shows("body") || !withBody() || props.tab.bodyMode !== "multipart"}
          {...rows("multipart")}
        />
        <datalist id="header-names">
          <For each={HEADER_NAMES}>{(name) => <option value={name} />}</For>
        </datalist>
        <datalist id="project-files">
          <For each={files()}>{(path) => <option value={path} />}</For>
        </datalist>
        <div
          id="req-body"
          ref={el}
          hidden={editorHidden()}
          onKeyDown={(e) => {
            // The format shortcut formats the JSON body here, not the open file (EditorPane.tsx skips it).
            if (raw() || props.tab.bodyMode !== "json" || !matches("format", e)) return;
            e.preventDefault();
            formatBody();
          }}
          data-empty={!raw() && !props.tab.body ? "" : undefined}
          data-placeholder={props.tab.bodyMode === "text" ? "Write the body as text" : "Write the body as JSON"}
        />
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
        hidden={editorHidden()}
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

/**
 * The response card: status pill and request line, headers, then the body in a box (red when it failed). `stale`: the
 * request has changed since this was sent, so it's dimmed, with a note.
 */
function Response(props: { card: Card | null; hidden: boolean; stale: boolean }) {
  return (
    <div class={["preview-response", { error: props.card ? !props.card.ok : false, stale: props.stale }]} hidden={props.hidden}>
      <Show when={props.card}>
        {(card) => (
          <>
            <div class="status-line">
              <Show when={card().status}>
                <span class="status">{card().status}</span>
              </Show>
              <span class="line">{card().line}</span>
              <Show when={props.stale}>
                <span class="stale-note">Request changed. Send again to update</span>
              </Show>
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
