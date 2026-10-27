import { createServer } from "vite";

const server = await createServer({
  root: process.cwd(),
  // chokidar treats the VFS root "/" as deleted and reports every file unlinked at startup; watchers never fire here anyway.
  server: { port: 5173, watch: null },
  // The dependency scanner runs rolldown's wasm bundler, which cannot see the playground's files: it would fail with a noisy warning.
  optimizeDeps: { noDiscovery: true },
});
await server.listen();
server.printUrls();
