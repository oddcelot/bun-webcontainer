// The messages between the editor and the content origin's host frame (contentHost.ts, host/main.ts). Every one is an
// envelope `{ v, kind, ... }`: `v` is the protocol version, which both sides check, so an editor and a host from
// different builds (a cached host.html, an embed built earlier) say so instead of misreading each other.

export const PROTOCOL_VERSION = 1;

/** Over `window.postMessage`, before the port exists (host -> editor, then editor -> host with the port). */
export type HandshakeMessage = { kind: "host-ready"; id: string } | { kind: "host-error"; message: string } | { kind: "connect" };

/** Over the MessagePort, editor -> host. `w` carries the Worker's ports in its transfer list, `fetch` a reply port. */
export type ToHost =
  | { kind: "spawn"; g: number }
  | { kind: "w"; g: number; d: unknown }
  | { kind: "kill"; g: number }
  | { kind: "fetch"; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null }
  | { kind: "ping"; n: number };

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
