import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

const require = createRequire(import.meta.url);
const browserDist = require.resolve("@rolldown/browser/package.json").replace(/package\.json$/, "dist/");

/** Host packages (see src/worker/hostPackages.ts): export names per specifier, taken from the native rolldown (same API as @rolldown/browser) so the page never instantiates the wasm binding. */
function hostPackageNames(): Plugin {
  const id = "virtual:host-package-names";
  return {
    name: "host-package-names",
    resolveId: (s) => (s === id ? "\0" + id : undefined),
    async load(s) {
      if (s !== "\0" + id) return;
      const names: Record<string, string[]> = {};
      for (const sub of ["", "/experimental", "/filter", "/parseAst", "/plugins", "/utils"]) {
        const m = await import(/* @vite-ignore */ "rolldown" + sub);
        names["rolldown" + sub] = Object.keys(m).filter((k) => k !== "default");
        if ("default" in m) names["rolldown" + sub].push("default");
      }
      const version = require("rolldown/package.json").version;
      return `export default ${JSON.stringify(names)}; export const version = ${JSON.stringify(version)};`;
    },
  };
}

/** emnapi picks its Node code paths (`worker.once`, ...) when `process.versions.node` is a string, and the worker's `process` shim says so. */
function emnapiNotNode(): Plugin {
  return {
    name: "emnapi-not-node",
    enforce: "pre",
    transform(code, id) {
      if (/@emnapi\/(core|wasi-threads)\/dist\/[^/]+\.js/.test(id)) return code.replace(/typeof process === 'object' && process !== null &&/g, "false &&");
    },
  };
}

export default defineConfig({
  plugins: [hostPackageNames(), emnapiNotNode()],
  build: { target: "esnext" },
  worker: { format: "es" },
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ["@rolldown/browser", "@napi-rs/wasm-runtime", "@emnapi/core", "@emnapi/runtime", "@emnapi/wasi-threads"] },
  resolve: {
    alias: [
      { find: /^@rolldown\/browser\/utils$/, replacement: browserDist + "utils-index.browser.mjs" },
      { find: /^(\.\.?\/)rolldown-binding\.wasi\.cjs$/, replacement: browserDist + "rolldown-binding.wasi-browser.js" },
    ],
  },
});
