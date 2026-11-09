import type { VFS } from "@runbun/vfs";
// The default project (no ?example=, ?repo= or share link): the examples repo's demo/, bundled into the page so it opens
// without a fetch. System colors in its styles.css (Canvas, ButtonFace, AccentColor, ...) follow color-scheme: no
// dark-mode rules. The same files as examples.ts takes from every project.
const files = import.meta.glob<string>(
  ["../examples/demo/**/*", "../examples/demo/**/.*", "!../examples/demo/**/node_modules/**", "!../examples/demo/example.json", "!../examples/demo/**/*.{png,jpg,jpeg,gif,webp,ico,woff,woff2,sqlite,db}"],
  { query: "?raw", import: "default", eager: true },
);

export function seedDemo(vfs: VFS) {
  for (const [path, text] of Object.entries(files)) vfs.write(path.slice("../examples/demo/".length), text);
}
