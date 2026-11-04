import { pref } from "./prefs";

/**
 * Keyboard shortcuts: each command's default chords, with the user's overrides (JSON, edited in the shortcuts dialog)
 * kept in localStorage and shared by every tab. A chord is `+`-joined modifiers and a key, e.g. `Mod+Shift+Enter`:
 * `Mod` is Cmd on macOS and Ctrl elsewhere; the key is a letter, digit, `Space` or `KeyboardEvent.key` name (`Enter`, `Escape`, `.`), any case.
 */

export const COMMANDS = {
  run: { label: "Run", keys: ["Mod+Enter"] },
  send: { label: "Send the preview's request", keys: ["Mod+Shift+Enter"] },
  stop: { label: "Stop the server", keys: ["Mod+."] },
  save: { label: "Save the file", keys: ["Mod+S"] },
  format: { label: "Format the file (bun fmt)", keys: ["Shift+Alt+F"] },
  goToDefinition: { label: "Go to the definition", keys: ["F12"] },
  showHover: { label: "Show the type at the cursor", keys: ["Mod+I"] },
  // Ctrl on macOS too, as there: Cmd+Space opens Spotlight.
  suggest: { label: "Suggest completions", keys: ["Ctrl+Space"] },
  signatureHelp: { label: "Show the parameters of the call", keys: ["Mod+Shift+Space"] },
  closeTab: { label: "Close the focused tab", keys: ["Mod+W", "Delete"] },
  toggleExplorer: { label: "Show or hide the file tree", keys: ["Mod+B"] },
  toggleConsole: { label: "Show or hide the console", keys: ["Mod+J"] },
  togglePreview: { label: "Show or hide the preview", keys: ["Mod+K"] },
  exitFullscreen: { label: "Leave the expanded preview", keys: ["Escape"] },
} satisfies Record<string, { label: string; keys: string[]; scope?: Scope }>;

/**
 * Whether the shortcuts dialog is recording keys: the shortcuts handled on the way down (App.tsx, ui/Preview.tsx)
 * leave the keys to it then. Its own listener comes later, on the same capture phase.
 */
let recording = false;
export const recordingKeys = () => recording;
export const setRecordingKeys = (on: boolean) => void (recording = on);

/**
 * Where a command's keys work, when not everywhere (`scope` in COMMANDS): there they go before the global commands'
 * keys, so the shortcuts dialog doesn't flag them against those. None is scoped yet; "preview" would be focus in the
 * preview (its request bar, panel and responses).
 */
export type Scope = "preview";
/** A command's scope, or undefined for everywhere. */
export const scopeOf = (command: Command): string | undefined => (COMMANDS[command] as { scope?: string }).scope;

export type Command = keyof typeof COMMANDS;
export type Overrides = Partial<Record<Command, string | string[] | null>>;

const STORAGE_KEY = "keymap";
const MODIFIERS = ["mod", "ctrl", "alt", "shift", "meta"];
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type Chord = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string };

function parse(chord: string): Chord | string {
  const parts = chord.split(/\+(?!$)/).map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return `empty chord "${chord}"`;
  const bad = parts.find((m) => !MODIFIERS.includes(m));
  if (bad) return `unknown modifier "${bad}" in "${chord}"`;
  const has = (m: string) => parts.includes(m);
  return {
    ctrl: has("ctrl") || (has("mod") && !isMac),
    alt: has("alt"),
    shift: has("shift"),
    meta: has("meta") || (has("mod") && isMac),
    key,
  };
}

/** The event's key, by physical key for letters, digits and the space bar so Alt and Shift (`π`, `!`) don't change it. */
const keyOf = (e: KeyboardEvent) => (e.code === "Space" ? "space" : (/^(?:Key|Digit)(.)$/.exec(e.code)?.[1] ?? e.key)).toLowerCase();

const [overrides, saveOverrides] = pref<Overrides>(STORAGE_KEY, {}, {
  deserialize(data) {
    const value: unknown = JSON.parse(data);
    const error = check(value);
    if (error) throw new Error(`${STORAGE_KEY}: ${error}`);
    return value as Overrides;
  },
});

// The parsed chords, for the overrides they came from (which another tab can change).
let bound: { from: Overrides; chords: Map<Command, Chord[]> } | undefined;

function chords(command: Command): Chord[] {
  const from = overrides();
  if (bound?.from !== from)
    bound = { from, chords: new Map((Object.keys(COMMANDS) as Command[]).map((c) => [c, keysFor(c).map(parse).filter((p): p is Chord => typeof p !== "string")])) };
  return bound.chords.get(command)!;
}

/** Why `value` isn't a valid overrides object, or undefined if it is. */
function check(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "Expected an object of command names to chords";
  for (const [c, v] of Object.entries(value)) {
    if (!(c in COMMANDS)) return `Unknown command "${c}"`;
    if (v === null) continue;
    const keys = typeof v === "string" ? [v] : v;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return `"${c}": expected a chord, a list of chords or null`;
    for (const k of keys) {
      const p = parse(k);
      if (typeof p === "string") return `"${c}": ${p}`;
    }
  }
}

/** The chords bound to `command` now (or with the overrides `o`), as written (`Mod+S`). */
export function keysFor(command: Command, o: Overrides = overrides()): string[] {
  if (!(command in o)) return COMMANDS[command].keys;
  const v = o[command];
  return v == null ? [] : typeof v === "string" ? [v] : v;
}

export function matches(command: Command, e: KeyboardEvent): boolean {
  const key = keyOf(e);
  return chords(command).some((c) => c.key === key && c.ctrl === e.ctrlKey && c.alt === e.altKey && c.shift === e.shiftKey && c.meta === e.metaKey);
}

/** The overrides in effect. */
export const currentOverrides = () => overrides();

/** Why `value` isn't a valid overrides object, or undefined if it is. */
export const checkOverrides = check;

/** Whether two chords are the same keys (`Mod+S` and `mod+s`; on macOS `Mod+S` and `Meta+S`). */
export function sameChord(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  if (typeof x === "string" || typeof y === "string") return a === b;
  return x.key === y.key && x.ctrl === y.ctrl && x.alt === y.alt && x.shift === y.shift && x.meta === y.meta;
}

/** The key event as a chord (`Mod+Shift+K`), with Cmd on macOS and Ctrl elsewhere as `Mod`; undefined for a modifier alone. */
export function chordOf(e: KeyboardEvent): string | undefined {
  if (["Shift", "Control", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Dead"].includes(e.key)) return undefined;
  const k = keyOf(e);
  const key = k === "space" ? "Space" : k.length === 1 ? k.toUpperCase() : e.key.toLowerCase() === k ? e.key : k;
  const mods = isMac
    ? [e.metaKey && "Mod", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"]
    : [e.ctrlKey && "Mod", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"];
  return [...mods.filter(Boolean), key].join("+");
}

/** A chord's keys for display, one per key: `⌘ ⇧ ↵` on macOS, `Ctrl Shift Enter` elsewhere. */
export function chordKeys(chord: string): string[] {
  const p = parse(chord);
  if (typeof p === "string") return [chord];
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1);
  if (isMac) {
    const symbol: Record<string, string> = { Enter: "↵", Escape: "Esc", Delete: "⌦", Backspace: "⌫", Arrowup: "↑", Arrowdown: "↓", Arrowleft: "←", Arrowright: "→" };
    return [p.ctrl && "⌃", p.alt && "⌥", p.shift && "⇧", p.meta && "⌘", symbol[key] ?? key].filter((k): k is string => !!k);
  }
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", p.meta && "Meta", key].filter((k): k is string => !!k);
}

/** The overrides as JSON for editing. */
export const overridesText = () => JSON.stringify(overrides(), null, 2);

/** Applies and keeps overrides given as JSON text; returns what's wrong with it instead if it isn't valid. */
export function setOverrides(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || "{}");
  } catch (e) {
    return (e as Error).message;
  }
  const error = check(value);
  if (error) return error;
  saveOverrides(value as Overrides);
}
