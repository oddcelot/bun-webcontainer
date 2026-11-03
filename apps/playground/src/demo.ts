import type { VFS } from "@runbun/vfs";
// The default project (no ?example=, ?repo= or share link), bundled into the page so it opens without a fetch.
// System colors in its styles.css (Canvas, ButtonFace, AccentColor, ...) follow color-scheme: no dark-mode rules.
import indexTs from "../fixtures/demo/index.ts?raw";
import utilTs from "../fixtures/demo/util.ts?raw";
import indexHtml from "../fixtures/demo/index.html?raw";
import clientTs from "../fixtures/demo/client.ts?raw";
import stylesCss from "../fixtures/demo/styles.css?raw";
import pkg from "../fixtures/demo/package.json?raw";

export function seedDemo(vfs: VFS) {
  vfs.write("index.ts", indexTs);
  vfs.write("util.ts", utilTs);
  vfs.write("index.html", indexHtml);
  vfs.write("client.ts", clientTs);
  vfs.write("styles.css", stylesCss);
  vfs.write("package.json", pkg);
}
