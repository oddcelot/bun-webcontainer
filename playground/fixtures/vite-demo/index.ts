import { createServer } from "vite";

const server = await createServer({
  root: process.cwd(),
  // chokidar treats the VFS root "/" as deleted and reports every file unlinked at startup; watchers never fire here anyway.
  server: { port: 5173, watch: null },
});
await server.listen();
server.printUrls();
