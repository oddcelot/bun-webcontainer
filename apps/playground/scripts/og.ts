// Generates the social card (public/og.png, 1200x630), the README badge (public/badge.svg) and the icons (favicon.svg, favicon.ico,
// favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png in public/) with Satori + resvg. Run `bun run og` after changing the copy or the logo;
// the outputs are committed. After changing the card's picture, bump `og.png?v=` where the pages name it (index.html,
// configure.html, apps/docs/astro.config.ts): social sites cache the image by its URL.
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

// Pierre Dark (the playground's default dark theme), plus Bun's cream from the logo: the badge's and the icons' colors.
const C = { bg: "#0a0a0a", panel: "#171717", fg: "#fafafa", muted: "#a3a3a3", border: "#262626", accent: "#009fff", bun: "#fbf0df" };

type El = { type: string; props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): El => ({
  type,
  props: { ...props, style: { display: "flex", ...style }, children },
});

// The social card: the landing page's kitchen by day (src/style.css #landing), from its props (src/landing/art/*.png,
// scripts/landing-art.ts) at four pixels an art pixel. Satori lays it out; the pictures are marked pixelated in its SVG,
// so resvg scales them without smoothing.
const K = { wall: "#fff6e5", ink: "#5b3a2e", muted: "#96735c", accent: "#c93f72", glow: "#ffc2d8" };
const ART = 4;
const png64 = (p: string) => `data:image/png;base64,${read(p).toString("base64")}`;
const art = (name: string) => png64(`src/landing/art/${name}.png`);
/** A picture `w` × `tall` art pixels with its left edge at `x`, standing `up` art pixels above the card's bottom edge. */
const prop = (src: string, w: number, tall: number, x: number, up: number) =>
  h("img", { position: "absolute", left: x, bottom: up * ART }, undefined, { src, width: w * ART, height: tall * ART });
/** The first frame of a sheet of `frames` square pictures of `size` art pixels, shown at `px` pixels an art pixel. */
const frame = (src: string, size: number, frames: number, rows: number, px: number, style: Record<string, unknown>) =>
  h("div", { width: size * px, height: size * px, overflow: "hidden", ...style }, [
    h("img", { flexShrink: 0 }, undefined, { src, width: size * px * frames, height: size * px * rows }),
  ]);
// The counter's strip is 26 art pixels high and the props stand 8 into its top, as on the page.
const STAND = 18;
const card = h("div", { width: 1200, height: 630, position: "relative", background: K.wall, color: K.ink, fontFamily: "Inter" }, [
  // Three rows of tiles behind the props, then the counter along the bottom.
  h("div", { position: "absolute", left: 0, bottom: 26 * ART, width: 1200, height: 48 * ART, overflow: "hidden", flexWrap: "wrap" },
    Array.from({ length: 20 }, () => h("img", {}, undefined, { src: art("tiles"), width: 32 * ART, height: 32 * ART }))),
  h("div", { position: "absolute", left: 0, bottom: 0, width: 1200, height: 26 * ART, overflow: "hidden" },
    Array.from({ length: 4 }, () => h("img", { flexShrink: 0 }, undefined, { src: art("counter"), width: 96 * ART, height: 26 * ART }))),
  // The dumpling sits in the steamer, between its back and the wall in front of it.
  prop(art("steamer-back"), 68, 42, 80, STAND),
  frame(png64("src/smile-idle.png"), 32, 16, 1, ART, { position: "absolute", left: 80 + 18 * ART, bottom: (STAND + 29) * ART }),
  prop(art("steamer-front"), 68, 42, 80, STAND),
  prop(art("rolling-pin"), 78, 16, 400, STAND - 4),
  prop(art("pot"), 60, 36, 760, STAND),
  frame(art("steam"), 0, 0, 0, 0, { display: "none" }),
  h("div", { position: "absolute", left: 760 + 15 * ART, bottom: (STAND + 33) * ART, width: 30 * ART, height: 40 * ART, overflow: "hidden" }, [
    h("img", { flexShrink: 0 }, undefined, { src: art("steam"), width: 30 * ART * 8, height: 40 * ART }),
  ]),
  prop(art("crock"), 36, 62, 1020, STAND),
  // The words, on the wall.
  h("div", { position: "absolute", left: 80, top: 44, flexDirection: "column" }, [
    h("div", { alignItems: "center", gap: 12, fontFamily: "Pixelify Sans", fontWeight: 700, fontSize: 34 }, [
      frame(png64("../../packages/ui/assets/dumplings.png"), 32, 8, 8, 2, {}),
      h("div", {}, "runbun.dev"),
    ]),
    h("div", { marginTop: 18, fontFamily: "Pixelify Sans", fontWeight: 700, fontSize: 96, lineHeight: 1, textShadow: `5px 5px 0 ${K.glow}` }, "Bun in your browser"),
    h("div", { marginTop: 22, fontSize: 30, lineHeight: 1.35, width: 1000 }, "Run Bun.serve apps, install packages and edit TypeScript in a tab. No install, no server, no account."),
  ]),
]);

const png = (svg: string, width: number) => new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();

const cardFonts = [...fonts, { name: "Pixelify Sans", weight: 700 as const, data: read("node_modules/@fontsource/pixelify-sans/files/pixelify-sans-latin-700-normal.woff") }];
const cardSvg = (await satori(card as never, { width: 1200, height: 630, fonts: cardFonts })).replaceAll("<image ", '<image image-rendering="optimizeSpeed" ');
writeFileSync(root + "public/og.png", png(cardSvg, 1200));

// "Open in runbun" badge for READMEs (public/badge.svg, linked from Share → Markdown/HTML). Satori turns the text into
// paths, so it looks the same wherever GitHub or anyone else shows it, without fonts.
const badge = h("div", { width: 150, height: 28, borderRadius: 6, overflow: "hidden", background: "#2a2c33" }, [
  h("div", { width: 32, height: 28, alignItems: "center", justifyContent: "center", background: C.bun }, [
    h("img", {}, undefined, { src: logo, width: 22, height: 19 }),
  ]),
  h("div", { flex: 1, alignItems: "center", justifyContent: "center", color: C.bun, fontSize: 13, fontWeight: 700, letterSpacing: 0.2 }, "Open in runbun"),
]);
const badgeFonts = [{ name: "Inter", weight: 700 as const, data: read("node_modules/@fontsource/inter/files/inter-latin-700-normal.woff") }];
writeFileSync(root + "public/badge.svg", await satori(badge as never, { width: 150, height: 28, fonts: badgeFonts }));

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
console.log("wrote public/og.png, badge.svg, favicon.svg, favicon.ico, favicon-32x32.png, apple-touch-icon.png, icon-192.png, icon-512.png");
