#!/usr/bin/env bun
// Draws a branded host's share card (the hosting file's `brand.card`, hosting/README.md) from the hosting file itself:
// its logo, name and description on its theme family's dark colors, with Satori + resvg like scripts/og.ts.
//   bun scripts/brand-card.ts hosting/example.json hosting/brand/solid-card.png
// The picture is committed next to the hosting file; rerun after changing the name, the description, the logo or the theme.
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { readFileSync, writeFileSync } from "node:fs";
import themes from "../../../packages/ui/themes.json" with { type: "json" };
import { readHostingFile } from "../hosting/load";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: bun scripts/brand-card.ts <hosting.json> <card.png>");
  process.exit(1);
}
// The card is what this draws: the file may name one that isn't there yet.
const hosting = readHostingFile(from, { card: false });
if (!hosting.brand) {
  console.error(`${from}: no brand to draw a card for`);
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const font = (weight: number) => readFileSync(`${root}node_modules/@fontsource/geist-sans/files/geist-sans-latin-${weight}-normal.woff`);
const fonts = [
  { name: "Geist", weight: 400 as const, data: font(400) },
  { name: "Geist", weight: 700 as const, data: font(700) },
];

// The theme family's dark variant (Pierre's without one): the page behind, the text, the accent.
// As the playground picks it (src/theme.ts): `family`, else the first of `families`.
const wanted = hosting.theme?.family ?? hosting.theme?.families?.[0];
const family = themes.families.find((f) => f.light === wanted || f.dark === wanted);
const chrome = (themes.chrome as Record<string, Record<string, string>>)[family?.dark ?? "pierre-dark"]!;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: string, b: string, share: number) =>
  `#${rgb(a)
    .map((v, i) => Math.round(v * share + rgb(b)[i]! * (1 - share)).toString(16).padStart(2, "0"))
    .join("")}`;
const C = { bg: chrome["--bg"]!, fg: "#ffffff", accent: chrome["--accent"]! };
const muted = mix(C.fg, C.bg, 0.68);

const logo = hosting.brand.logoDark ?? hosting.brand.logo;
// An SVG says its own shape; anything else is drawn square.
const svg = logo.startsWith("data:image/svg+xml;base64,") ? Buffer.from(logo.slice(logo.indexOf(",") + 1), "base64").toString() : "";
const box = /viewBox="[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svg);
const ratio = box ? Number(box[1]) / Number(box[2]) : 1;

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): El => ({
  type,
  props: { ...props, style: { display: "flex", ...style }, children },
});
const mark = (height: number, style: Record<string, unknown> = {}) => h("img", style, undefined, { src: logo, width: Math.round(height * ratio), height });

const card = h(
  "div",
  {
    // Satori adds the padding to the size.
    width: 1200 - 168,
    height: 630 - 10,
    position: "relative",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 88px 10px 80px",
    backgroundColor: C.bg,
    // A glow of the accent (the brand's color) behind the big mark, and the page a shade lighter towards it.
    backgroundImage: `radial-gradient(circle at 82% 48%, ${mix(C.accent, C.bg, 0.42)} 0%, ${mix(C.accent, C.bg, 0.12)} 34%, ${C.bg} 62%)`,
    color: C.fg,
    fontFamily: "Geist",
  },
  [
    h("div", { flexDirection: "column", width: 680 }, [
      h("div", { fontSize: 84, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.05 }, hosting.name),
      hosting.brand.description ? h("div", { marginTop: 28, fontSize: 32, lineHeight: 1.35, color: muted }, hosting.brand.description) : null,
    ]),
    mark(280),
    h("div", { position: "absolute", left: 0, bottom: 0, width: 1200, height: 10, backgroundImage: `linear-gradient(90deg, ${mix(C.accent, C.bg, 0.35)}, ${C.accent})` }),
  ],
);

const out = new Resvg(await satori(card as never, { width: 1200, height: 630, fonts }), { fitTo: { mode: "width", value: 1200 } }).render().asPng();
writeFileSync(to, out);
console.log(`brand-card: ${to} (${(out.length / 1024).toFixed(0)} kB)`);
