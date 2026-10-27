import { createServer } from "vite";

const server = await createServer({ root: ".", server: { port: 5173 } });
await server.listen();
server.printUrls();
