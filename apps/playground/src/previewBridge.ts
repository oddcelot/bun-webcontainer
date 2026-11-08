import { CONTENT_ORIGIN } from "./contentOrigin";
import { MAX_CARD_TEXT, MAX_PATH, MAX_TITLE, envelope, isMessage, type FromFrame, type ToFrame } from "./contentProtocol";
import { windowChords } from "./keymap";
import { PREFIX, cardOf } from "./preview";
import { themeState } from "./theme";
import type { Previews } from "./ui/previews";

// The editor's end of the preview bridge (swPage.ts previewBridge, messages in contentProtocol.ts). A previewed page is
// untrusted and can post anything to the editor, so a message counts only from a preview tab's own iframe window at the
// content origin (not a nested frame, not another window), and each field is checked before it is used. Nothing from
// the page is evaluated, nor put into the document as markup.

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isKeyName = (v: unknown): v is string => isStr(v, 32);

/**
 * `path` if it stays inside the preview (below `/__preview/@<id>`): absolute, with no dot segments or backslashes or
 * control characters that would walk out of it when the browser resolves it. Otherwise undefined.
 */
export function withinPreview(path: unknown): string | undefined {
  if (!isStr(path, MAX_PATH) || !path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return;
  try {
    const u = new URL(PREFIX + path, CONTENT_ORIGIN);
    if (u.origin !== CONTENT_ORIGIN || (u.pathname !== PREFIX && !u.pathname.startsWith(`${PREFIX}/`))) return;
  } catch {
    return;
  }
  return path;
}

/** A message from a preview document, if it has the shape of one; anything else is undefined. */
export function parseFromFrame(data: unknown): FromFrame | undefined {
  if (!isMessage<FromFrame>(data, "preview bridge")) return;
  const m = data as Record<string, unknown>;
  switch (m.kind) {
    case "hello":
    case "bye":
      return { kind: m.kind };
    case "key":
      if (isKeyName(m.key) && isKeyName(m.code) && [m.ctrl, m.alt, m.shift, m.meta, m.repeat].every((b) => typeof b === "boolean"))
        return { kind: "key", key: m.key, code: m.code, ctrl: m.ctrl as boolean, alt: m.alt as boolean, shift: m.shift as boolean, meta: m.meta as boolean, repeat: m.repeat as boolean };
      return;
    case "open-tab": {
      const path = withinPreview(m.path);
      if (path !== undefined && typeof m.foreground === "boolean") return { kind: "open-tab", path, foreground: m.foreground };
      return;
    }
    case "loaded": {
      const path = withinPreview(m.path);
      const status = m.status;
      if (path === undefined || !isStr(m.title, MAX_TITLE) || !isStr(m.contentType, 200) || typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 999) return;
      if (m.text !== undefined && !isStr(m.text, MAX_CARD_TEXT)) return;
      return { kind: "loaded", path, title: m.title, contentType: m.contentType, status, text: m.text };
    }
  }
}

/** Sends the preview document at `win` a message (it takes it only if it is at the content origin). */
export function sendToFrame(win: Window | null | undefined, m: ToFrame) {
  win?.postMessage(envelope(m), CONTENT_ORIGIN!);
}

/** A page can open preview tabs, but not without end (one that opens one on every load would never stop): this many, this often. */
const MAX_TABS = 16;
const OPEN_EVERY_MS = 400;
let lastOpen = 0;

/** The window's `message` handler for the preview tabs of `p`. */
export function onFrameMessage(e: MessageEvent, p: Previews) {
  if (e.origin !== CONTENT_ORIGIN) return;
  const id = p.tabOf(e.source);
  if (id === undefined) return;
  const m = parseFromFrame(e.data);
  if (!m) return;
  if (m.kind === "hello") {
    p.setLive(id, true);
    sendToFrame(e.source as Window, { kind: "init", mode: themeState().mode, shortcuts: windowChords() });
  } else if (m.kind === "bye") p.setLive(id, false);
  else if (m.kind === "key") {
    // As if pressed in the playground: its shortcuts take it from the window (App.tsx, ui/Preview.tsx).
    dispatchEvent(new KeyboardEvent("keydown", { key: m.key, code: m.code, ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta, repeat: m.repeat, bubbles: true, cancelable: true }));
  } else if (m.kind === "open-tab") {
    if (p.state.tabs.length >= MAX_TABS || Date.now() - lastOpen < OPEN_EVERY_MS) return;
    lastOpen = Date.now();
    const from = p.state.active;
    p.request(p.open(m.path));
    if (!m.foreground) p.activate(from);
  } else {
    p.setLive(id, true);
    p.adopt(id, m.path, m.title, cardOf(m.path, m.contentType, m.status, m.text ?? ""));
  }
}

