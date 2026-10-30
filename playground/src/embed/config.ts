import { FEATURES, MODES, type Feature, type Mode, type Options } from "./protocol";

/** What each mode shows and turns on before the author's `features` list. */
export const PRESETS: Record<Mode, readonly Feature[]> = {
  code: ["console", "open"],
  console: ["console", "terminal", "open"],
  preview: ["tabs", "preview", "install", "open"],
  full: ["files", "tabs", "console", "preview", "format", "install", "terminal", "open"],
  result: ["preview", "open"],
};

/** What a feature costs to turn on, for the embed's menu. */
export const COST: Partial<Record<Feature, string>> = { types: "12 MB", format: "9 MB" };

export const isMode = (s: unknown): s is Mode => MODES.includes(s as Mode);
export const isFeature = (s: unknown): s is Feature => FEATURES.includes(s as Feature);

/** The author's `features` list: names turned on, and names turned off (`-name`), which readers can't turn on. */
export function parseFeatures(list: string): { on: Feature[]; off: Feature[] } {
  const on: Feature[] = [];
  const off: Feature[] = [];
  for (const raw of list.split(/[\s,]+/)) {
    const name = raw.replace(/^[-+]/, "");
    if (isFeature(name)) (raw.startsWith("-") ? off : on).push(name);
  }
  return { on, off };
}

/** The features in effect: the mode's preset, the author's list, then changes made since (menu or API). */
export function resolveFeatures(mode: Mode, authored: string, changes: Partial<Record<Feature, boolean>>): Feature[] {
  const { on, off } = parseFeatures(authored);
  const set = new Set<Feature>([...PRESETS[mode], ...on]);
  for (const f of off) set.delete(f);
  for (const [f, v] of Object.entries(changes) as [Feature, boolean][]) v ? set.add(f) : set.delete(f);
  return FEATURES.filter((f) => set.has(f));
}

/** Features the author turned off with `-name`: the menu doesn't offer them. */
export const lockedFeatures = (authored: string) => new Set(parseFeatures(authored).off);

const bool = (s: string | null, fallback: boolean) => (s === null ? fallback : s !== "false" && s !== "0");

/** Options from the embed URL's parameters; unknown or malformed ones fall back to the defaults. */
export function optionsFromUrl(params: URLSearchParams): Options {
  const mode = params.get("mode");
  const m: Mode = isMode(mode) ? mode : "code";
  return {
    mode: m,
    features: params.get("features") ?? "",
    file: params.get("file") ?? "",
    autorun: bool(params.get("autorun"), m !== "full"),
    theme: params.get("theme") ?? "auto",
    readonly: bool(params.get("readonly"), false),
    persist: params.get("persist") ?? "",
  };
}
