import { FEATURES, MODES, type Feature, type Mode, type Options } from "@runbun/embed/protocol";

/** What each mode shows and turns on before the author's `features` list. */
export const PRESETS: Record<Mode, readonly Feature[]> = {
  code: ["console", "open", "watch"],
  console: ["console", "terminal", "open", "watch"],
  preview: ["tabs", "preview", "install", "open", "watch"],
  full: ["files", "tabs", "console", "preview", "format", "install", "terminal", "open", "watch", "close", "git"],
  result: ["preview", "open", "watch"],
};

/** What a feature costs to turn on, for the embed's menu. */
export const COST: Partial<Record<Feature, string>> = { types: "10 MB", format: "7 MB", git: "1 MB" };

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

/** `expand` (or `expand=on`) for the button, `expand=<mode>` to switch modes too, `false` or absent for none. */
function expandOption(params: URLSearchParams): Options["expand"] {
  const v = params.get("expand");
  if (v === null || v === "false" || v === "0") return "";
  return isMode(v) ? v : "on";
}

const bool = (s: string | null, fallback: boolean) => (s === null ? fallback : s !== "false" && s !== "0");

/** Options from the embed URL's parameters; unknown or malformed ones fall back to the defaults. */
export function optionsFromUrl(params: URLSearchParams): Options {
  const mode = params.get("mode");
  const m: Mode = isMode(mode) ? mode : "code";
  return {
    mode: m,
    features: params.get("features") ?? "",
    file: params.get("file") ?? "",
    path: params.get("path") ?? "",
    requests: params.get("requests") ?? "",
    autorun: bool(params.get("autorun"), m !== "full"),
    theme: params.get("theme") ?? "auto",
    family: params.get("family") ?? "",
    fonts: params.get("fonts") ?? "",
    readonly: bool(params.get("readonly"), false),
    persist: params.get("persist") ?? "",
    expand: expandOption(params),
    status: params.get("status") === "bar" ? "bar" : "toast",
    layout: params.get("layout") === "stack" ? "stack" : "side",
  };
}
