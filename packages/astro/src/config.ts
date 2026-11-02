// The integration's resolved options, for the fence plugin: it runs in the same process, after astro:config:setup.
const KEY = Symbol.for("@runbun/astro");

export interface ResolvedConfig {
  playgroundUrl: string;
  base: string;
  sync?: { scheme?: string; family?: string } | undefined;
}

const DEFAULTS: ResolvedConfig = { playgroundUrl: "https://runbun.dev/", base: "/", sync: undefined };
const store = globalThis as unknown as Record<symbol, ResolvedConfig | undefined>;

export const CONFIG = (): ResolvedConfig => store[KEY] ?? DEFAULTS;
export const setConfig = (config: Partial<ResolvedConfig>): ResolvedConfig => (store[KEY] = { ...DEFAULTS, ...config });
