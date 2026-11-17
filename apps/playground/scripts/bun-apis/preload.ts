// bunfig.toml's preload: runs before main.ts is loaded, so the plugin it registers serves main.ts's static import.
import { plugin } from "bun";

(globalThis as { preloaded?: string }).preloaded = `for ${Bun.main.slice(Bun.main.lastIndexOf("/") + 1)}`;
plugin({
  name: "preloaded",
  setup(build) {
    build.module("preloaded:greeting", () => ({ contents: "export default 'hello from a preloaded plugin'", loader: "js" }));
  },
});
