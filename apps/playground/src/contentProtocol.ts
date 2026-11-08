// The messages between the editor and the content origin's host frame (contentHost.ts, host/main.ts). Every one is an
// envelope `{ v, kind, ... }`: `v` is the protocol version, which both sides check, so an editor and a host from
// different builds (a cached host.html, an embed built earlier) say so instead of misreading each other.

export const PROTOCOL_VERSION = 1;

/**
 * Over `window.postMessage`, before the port exists (host -> editor, then editor -> host with the port).
 * `host-ready.isolated`: whether the host frame is cross-origin isolated (SharedArrayBuffer, Atomics.wait for its Worker).
 * Not so when an embedder did not delegate `cross-origin-isolated` or is not isolated itself; the editor then keeps package
 * files in memory instead of the store (a lazy read would block for ever). Absent (an older host) means not isolated.
 */
export type HandshakeMessage = { kind: "host-ready"; id: string; isolated?: boolean } | { kind: "host-error"; message: string } | { kind: "connect" };

/** Over the MessagePort, editor -> host. `w` carries the Worker's ports in its transfer list, `fetch` a reply port. */
export type ToHost =
  | { kind: "spawn"; g: number }
  | { kind: "w"; g: number; d: unknown }
  | { kind: "kill"; g: number }
  | { kind: "fetch"; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
  | { kind: "ping"; n: number }
  /** The server stopped (the editor's Stop or Run): tell this origin's preview pages, as the editor's own channel tells its origin's. */
  | { kind: "stopped" }
  /**
   * The preview's cookies in the browser, which live on this origin (the host frame owns the page whose document.cookie
   * reads and writes them under `base`, `/__preview/@<id>`): `read` answers `{ cookie }` on the reply port; `write` takes
   * `document.cookie` assignments and answers nothing.
   */
  | { kind: "cookies"; op: "read"; base: string }
  | { kind: "cookies"; op: "write"; base: string; lines: string[] }
  /**
   * The package store (pkgStore.ts) lives on this origin: its OPFS, and the answer to the Worker's synchronous lazy
   * read, which can't cross origins. `store-put` hands over a package's large files (one ArrayBuffer, transferred; `url`
   * is the tarball they came from, to rebuild the entry if it goes missing) and is answered `{}` once stored;
   * `store-read` answers `{ buf }` with `size` bytes at `at` of entry `key`; `store-info` `{ entries, bytes }`;
   * `store-clear` `{}`. A failure is answered `{ error }`. No message carries shared memory.
   */
  /** `store-put` answers `{ warning }` when the write failed twice and the host holds the entry in memory instead. */
  | { kind: "store-put"; key: string; url: string; buf: ArrayBuffer }
  | { kind: "store-read"; key: string; url: string; at: number; size: number }
  | { kind: "store-info" }
  | { kind: "store-clear" };

/** Over the MessagePort, host -> editor. `sw` carries the service worker's reply port. */
export type ToEditor =
  | { kind: "w"; g: number; d: unknown }
  | { kind: "werr"; g: number; message: string }
  | { kind: "sw"; d: any }
  /** A message to the host could not be read (messageerror: e.g. shared memory sent across origins). */
  | { kind: "merr" }
  | { kind: "pong"; n: number; workers: number };

type Envelope = { v: number; kind: string };

const complained = new Set<number | string>();

/**
 * True if `data` is an envelope of this protocol version. Anything else is ignored; a different version is logged, once
 * per version (`where` names the side), as it will be every message of that peer.
 */
export function isMessage<T extends { kind: string }>(data: unknown, where: string): data is T & Envelope {
  if (typeof data !== "object" || data === null || typeof (data as Envelope).kind !== "string") return false;
  const v = (data as Envelope).v;
  if (v === PROTOCOL_VERSION) return true;
  if (!complained.has(String(v))) {
    complained.add(String(v));
    console.warn(`[content origin] ${where}: ignoring messages of protocol version ${String(v)} (this build speaks ${PROTOCOL_VERSION}); the editor and the host page are from different builds`);
  }
  return false;
}

/** Wraps a message in the envelope. */
export const envelope = <T extends { kind: string }>(m: T): T & { v: typeof PROTOCOL_VERSION } => ({ v: PROTOCOL_VERSION, ...m });

/**
 * The preview bridge: messages between the editor and a preview document on the content origin (the script the service
 * worker injects, swPage.ts previewBridge). Same envelope and version as above. Previewed pages are untrusted and
 * can send anything, so the editor takes these only from a preview iframe's own window and origin and validates every
 * field (previewBridge.ts); the frame side takes them only from its parent, at the configured editor origin.
 */

/** A chord the editor owns (a keymap command, parsed): the bridge keeps its key from the page, and forwards it. */
export type OwnedChord = { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

/** Preview document -> editor. `path` is relative to the preview's base (`/__preview/@<id>`). */
export type FromFrame =
  /** A document with a bridge started: answered with `init`. */
  | { kind: "hello" }
  /** The document is going away: the editor can't message it any more. */
  | { kind: "bye" }
  | { kind: "key"; key: string; code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; repeat: boolean }
  /** A link that opens a preview tab: in the background, or switched to (`foreground`). */
  | { kind: "open-tab"; path: string; foreground: boolean }
  | { kind: "loaded"; path: string; title: string; contentType: string; status: number; text?: string };

/** Editor -> preview document. */
export type ToFrame =
  | { kind: "init"; mode: string; shortcuts: OwnedChord[] }
  | { kind: "color-scheme"; mode: string }
  | { kind: "navigate"; path: string };

/** Longest text a `loaded` card may carry, and longest path or title. */
export const MAX_CARD_TEXT = 2_000_000;
export const MAX_PATH = 4096;
export const MAX_TITLE = 1024;
