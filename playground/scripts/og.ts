// Generates the social card (public/og.png, 1200x630) and the icons (favicon.svg, favicon.ico,
// favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png in public/) with Satori + resvg. Run `bun run og` after changing the copy or the logo;
// the outputs are committed.
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(root + p);
const logoSvg = read("src/bun-logo.svg");
const logo = `data:image/svg+xml;base64,${logoSvg.toString("base64")}`;

const fonts = [
  { name: "Inter", weight: 400, data: read("node_modules/@fontsource/inter/files/inter-latin-400-normal.woff") },
  { name: "Inter", weight: 800, data: read("node_modules/@fontsource/inter/files/inter-latin-800-normal.woff") },
  { name: "JetBrains Mono", weight: 500, data: read("node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff") },
] as const;

// Pierre Dark (the playground's default dark theme), plus Bun's cream from the logo.
const C = { bg: "#0a0a0a", panel: "#171717", fg: "#fafafa", muted: "#a3a3a3", border: "#262626", accent: "#009fff", bun: "#fbf0df" };

type El = { type: string; props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): El => ({
  type,
  props: { ...props, style: { display: "flex", ...style }, children },
});

const chip = (text: string) =>
  h("div", { padding: "10px 18px", border: `1px solid ${C.border}`, borderRadius: 999, background: C.panel, color: C.fg, fontFamily: "JetBrains Mono", fontSize: 24 }, text);

const card = h(
  "div",
  {
    // Satori adds padding to width and height (content-box), so these are 1200x630 minus the padding.
    width: 1200 - 160,
    height: 630 - 128,
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "64px 80px",
    background: C.bg,
    // A warm glow behind the logo, Bun's cream fading into the dark.
    backgroundImage: `radial-gradient(circle at 85% 50%, rgba(251, 240, 223, 0.16), rgba(10, 10, 10, 0) 45%)`,
    color: C.fg,
    fontFamily: "Inter",
  },
  [
    h("div", { alignItems: "center", gap: 14, color: C.muted, fontSize: 28 }, [
      h("img", {}, undefined, { src: logo, width: 46, height: 40 }),
      h("div", {}, "runbun.dev"),
    ]),
    h("div", { alignItems: "center", justifyContent: "space-between", gap: 40 }, [
      h("div", { flexDirection: "column", gap: 20, width: 760 }, [
        h("div", { fontSize: 80, fontWeight: 800, letterSpacing: -2.5, lineHeight: 1.05 }, "Bun in your browser"),
        h(
          "div",
          { fontSize: 30, color: C.muted, lineHeight: 1.4 },
          "Run Bun.serve apps, install packages and edit TypeScript in a tab, built from Bun's own Rust crates compiled to wasm64.",
        ),
      ]),
      h("img", { flexShrink: 0 }, undefined, { src: logo, width: 240, height: 210 }),
    ]),
    h("div", { gap: 14 }, ["Bun.serve", "bun install", "TypeScript", "wasm64"].map(chip)),
  ],
);

const png = (svg: string, width: number) => new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();

writeFileSync(root + "public/og.png", png(await satori(card as never, { width: 1200, height: 630, fonts: [...fonts] }), 1200));

// iOS home screen icon: the logo on Bun's cream, with room around it (iOS rounds the corners).
const touch = h("div", { width: 180, height: 180, alignItems: "center", justifyContent: "center", background: C.bun }, [
  h("img", {}, undefined, { src: logo, width: 132, height: 116 }),
]);
writeFileSync(root + "public/apple-touch-icon.png", png(await satori(touch as never, { width: 180, height: 180, fonts: [...fonts] }), 180));

// The logo centered in a transparent square (it's 80x70), for favicons and the web manifest.
const square = async (size: number) => {
  const w = Math.round(size * 0.96);
  const el = h("div", { width: size, height: size, alignItems: "center", justifyContent: "center" }, [
    h("img", {}, undefined, { src: logo, width: w, height: Math.round((w * 70) / 80) }),
  ]);
  return png(await satori(el as never, { width: size, height: size, fonts: [...fonts] }), size);
};

/** An .ico of PNG images (Vista+ format): Google Search doesn't use SVG favicons. */
function ico(images: [size: number, data: Buffer][]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e); // 0 means 256
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(([, d]) => d)]);
}

const sizes = Object.fromEntries(await Promise.all([16, 32, 48, 192, 512].map(async (n) => [n, await square(n)] as const)));
writeFileSync(root + "public/favicon.ico", ico([16, 32, 48].map((n) => [n, sizes[n]])));
writeFileSync(root + "public/favicon-32x32.png", sizes[32]);
writeFileSync(root + "public/icon-192.png", sizes[192]);
writeFileSync(root + "public/icon-512.png", sizes[512]);

copyFileSync(root + "src/bun-logo.svg", root + "public/favicon.svg");
console.log("wrote public/og.png, favicon.svg, favicon.ico, favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png");
