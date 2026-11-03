import { pref } from "./prefs";

/**
 * Keyboard shortcuts: each command's default chords, with the user's overrides (JSON, edited in the shortcuts dialog)
 * kept in localStorage and shared by every tab. A chord is `+`-joined modifiers and a key, e.g. `Mod+Shift+Enter`:
 * `Mod` is Cmd on macOS and Ctrl elsewhere; the key is a letter, digit, `Space` or `KeyboardEvent.key` name (`Enter`, `Escape`, `.`), any case.
 */

export const COMMANDS = {
  run: { label: "Run", keys: ["Mod+Enter"] },
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
} satisfies Record<string, { label: string; keys: string[] }>;

export type Command = keyof typeof COMMANDS;
type Overrides = Partial<Record<Command, string | string[] | null>>;

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

/** The chords bound to `command` now, as written (`Mod+S`). */
export function keysFor(command: Command): string[] {
  const o = overrides();
  if (!(command in o)) return COMMANDS[command].keys;
  const v = o[command];
  return v == null ? [] : typeof v === "string" ? [v] : v;
}

export function matches(command: Command, e: KeyboardEvent): boolean {
  const key = keyOf(e);
  return chords(command).some((c) => c.key === key && c.ctrl === e.ctrlKey && c.alt === e.altKey && c.shift === e.shiftKey && c.meta === e.metaKey);
}

/** A chord for display: `⌘⇧↵` on macOS, `Ctrl+Shift+Enter` elsewhere. */
export function formatChord(chord: string): string {
  const p = parse(chord);
  if (typeof p === "string") return chord;
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1);
  if (isMac) {
    const symbol: Record<string, string> = { Enter: "↵", Escape: "Esc", Delete: "⌦", Backspace: "⌫", Arrowup: "↑", Arrowdown: "↓", Arrowleft: "←", Arrowright: "→" };
    return (p.ctrl ? "⌃" : "") + (p.alt ? "⌥" : "") + (p.shift ? "⇧" : "") + (p.meta ? "⌘" : "") + (symbol[key] ?? key);
  }
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", p.meta && "Meta", key].filter(Boolean).join("+");
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
