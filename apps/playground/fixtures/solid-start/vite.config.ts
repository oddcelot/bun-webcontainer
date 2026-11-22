import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// Start mode owns the entries; the toolbar is mounted by the plugin because @solidjs/start-devtools is installed.
export default defineConfig({
  plugins: [solid({ ssr: true, start: { devtools: true }, serverFunctions: true })],
});
