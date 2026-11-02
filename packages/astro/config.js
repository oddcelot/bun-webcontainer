// The integration's resolved options, for the fence plugin: it runs in the same process, after astro:config:setup.
const KEY = Symbol.for("@runbun/astro");

const DEFAULTS = { playgroundUrl: "https://runbun.dev/", base: "/", sync: undefined };

export const CONFIG = () => globalThis[KEY] ?? DEFAULTS;
export const setConfig = (config) => (globalThis[KEY] = { ...DEFAULTS, ...config });
