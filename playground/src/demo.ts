import type { VFS } from "./vfs";

const indexTs = `import homepage from "./index.html";
import { greet } from "./util.ts";

const server = Bun.serve({
  routes: {
    "/": homepage,
    "/api/hello/:name": (req) => {
      console.log("request", req.method, new URL(req.url).pathname);
      return Response.json({ message: greet(req.params.name), bun: Bun.version });
    },
  },
});

console.log("Bun " + Bun.version + " listening on " + server.url);
console.log("semver ^1.0.0 satisfies 1.2.3:", Bun.semver.satisfies("1.2.3", "^1.0.0"));
`;

const utilTs = `export function greet(name: string): string {
  return "Hello, " + name + "!";
}
`;

const indexHtml = `<!doctype html>
<html>
  <head>
    <title>Bun playground</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <h1>Bun.serve + HTML import</h1>
    <p id="msg">loading...</p>
    <button id="party">🎉 Confetti</button>
    <script type="module" src="./client.ts"></script>
  </body>
</html>
`;

const clientTs = `import confetti from "canvas-confetti";

const res = await fetch("/api/hello/preview");
const { message, bun }: { message: string; bun: string } = await res.json();
document.querySelector("#msg")!.textContent = \`\${message} (Bun \${bun})\`;

const party = () => confetti({ particleCount: 150, spread: 70, origin: { y: 0.7 } });
document.querySelector<HTMLButtonElement>("#party")!.onclick = party;
party();
`;

const stylesCss = `body { font-family: system-ui; padding: 1rem; }
button { font-size: 1.1rem; padding: 0.4rem 0.9rem; cursor: pointer; }
`;

const pkg = `{
  "name": "demo",
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "dependencies": {
    "canvas-confetti": "^1.9.3"
  }
}
`;

export function seedDemo(vfs: VFS) {
  vfs.write("index.ts", indexTs);
  vfs.write("util.ts", utilTs);
  vfs.write("index.html", indexHtml);
  vfs.write("client.ts", clientTs);
  vfs.write("styles.css", stylesCss);
  vfs.write("package.json", pkg);
}
