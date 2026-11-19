// bunfig.toml's preload: runs before main.ts is loaded, so the plugin it registers serves main.ts's static import.
import { plugin } from "bun";

(globalThis as { preloaded?: string }).preloaded = `for ${Bun.main.slice(Bun.main.lastIndexOf("/") + 1)}`;
plugin({
  name: "preloaded",
  setup(build) {
    // The program itself goes through a preloaded plugin's onLoad, like what it imports.
    build.onLoad({ filter: /\/main\.ts$/ }, async ({ path }) => ({
      contents: `(globalThis as { entryVia?: string }).entryVia = "onLoad";\n${await Bun.file(path).text()}`,
      loader: "ts",
    }));
    build.module("preloaded:greeting", () => ({ contents: "export default 'hello from a preloaded plugin'", loader: "js" }));
  },
});
