import { defineConfig } from "astro/config";
import solid from "@astrojs/solid-js";

export default defineConfig({
  integrations: [solid()],
  server: { port: 4321 },
  // The dev toolbar talks over Vite's HMR socket, which can't connect in the playground.
  devToolbar: { enabled: false },
  vite: {
    server: {
      hmr: false,
      // chokidar treats the VFS root "/" as deleted and reports every file unlinked at startup (Astro would restart
      // forever); watchers never fire anyway. Not `watch: null`: merged into Astro's config, a null is dropped.
      watch: { ignored: () => true },
    },
  },
});
