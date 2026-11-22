// First: Satori loads under it.
import { restoreLocation } from "./satoriInWorker";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import satori, { init as initSatori } from "satori/standalone";
import layoutWasm from "satori/layout.wasm";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff";
import inter800 from "@fontsource/inter/files/inter-latin-800-normal.woff";
import logoSvg from "../src/bun-logo.svg";
import { CONFIG_FILE, readConfig } from "../src/projectConfig";

restoreLocation();

// A shared project's own share card: the picture a short link gets where it is posted, instead of the site's. Opt-in,
// with `card` in the project's runbun.json (src/projectConfig.ts). The Worker reads the file out of the link's payload
// when the link is made, keeps what the card says with the link, and draws the picture when something first asks for
// it: Satori lays the card out as SVG (text as outlines, so no font reaches the renderer), resvg makes the PNG.
// Only text from runbun.json is drawn: a link can't put a picture of its own under this host's name.

/** What a card says, as kept in the link's KV metadata (1024 bytes for all of it, see `fit`). */
export interface Card {
  title: string;
  description?: string;
  tags?: string[];
  /** "#rrggbb". */
  accent?: string;
}

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 180;
const TAGS_MAX = 4;
const TAG_MAX = 24;
/** A payload inflates to at most this much text, or it has no card: a few hundred times what a project's files take. */
const INFLATED_MAX = 4 * 1024 * 1024;

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** The payload's files (src/share.ts: JSON, deflated, base64url), or null for anything else. */
async function filesOf(payload: string): Promise<Record<string, string> | null> {
  try {
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    for (let size = 0; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.length) > INFLATED_MAX) return void reader.cancel(), null;
      chunks.push(value);
    }
    const data = JSON.parse(await new Response(new Blob(chunks)).text()) as { files?: unknown };
    return data.files && typeof data.files === "object" ? (data.files as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** The card of the project in `payload`, if its runbun.json asks for one. */
export async function cardFor(payload: string): Promise<Card | null> {
  const files = await filesOf(payload);
  const text = (path: string) => (typeof files?.[path] === "string" ? files[path] : undefined);
  if (!files || text(CONFIG_FILE) === undefined) return null;
  const config = readConfig(text);
  if (!config.card) return null;
  let pkg: { name?: unknown; description?: unknown } = {};
  try {
    pkg = JSON.parse(text("package.json") ?? "{}");
  } catch {}
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const title = config.card.title ?? config.name ?? str(pkg.name);
  if (!title) return null;
  const description = config.card.description ?? config.description ?? str(pkg.description);
  const tags = (config.tags ?? []).slice(0, TAGS_MAX).map((t) => clip(t, TAG_MAX)).filter(Boolean);
  return fit({
    title: clip(title, TITLE_MAX),
    ...(description ? { description: clip(description, DESCRIPTION_MAX) } : {}),
    ...(tags.length ? { tags } : {}),
    ...(config.card.accent ? { accent: config.card.accent } : {}),
  });
}

/** Room for a card in the metadata, beside the link's dates. */
const CARD_BYTES = 900;
const bytes = (card: Card) => new TextEncoder().encode(JSON.stringify(card)).length;

/** The card within CARD_BYTES: text in a script of three bytes a character can pass it, and then says less. */
function fit(card: Card): Card {
  if (bytes(card) > CARD_BYTES) card = { ...card, tags: undefined };
  for (let max = DESCRIPTION_MAX; card.description && bytes(card) > CARD_BYTES; max = Math.floor(max / 2)) card = { ...card, description: max > 20 ? clip(card.description, max) : undefined };
  return JSON.parse(JSON.stringify(card));
}

// Pierre Dark, the playground's default dark theme, as scripts/og.ts has it.
const C = { bg: "#0a0a0a", panel: "#171717", fg: "#fafafa", muted: "#a3a3a3", border: "#262626", accent: "#009fff" };
const logo = `data:image/svg+xml;base64,${btoa(logoSvg)}`;

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): El => ({
  type,
  props: { ...props, style: { display: "flex", ...style }, children },
});

/**
 * Starts both wasm modules, once per isolate. Each request that finds them not started starts them itself: a promise
 * from one request can't be awaited by another, and a second start does no harm (resvg refuses it, which is fine).
 */
let started = false;
async function start() {
  if (started) return;
  await Promise.all([
    initSatori(layoutWasm),
    initWasm(resvgWasm).catch((e) => {
      if (!/already initialized/i.test(String(e))) throw e;
    }),
  ]);
  started = true;
}

const FONTS = [
  { name: "Inter", weight: 400 as const, data: inter400 },
  { name: "Inter", weight: 800 as const, data: inter800 },
];

/** The card as a 1200x630 PNG. `site` is the host's name, beside the logo. */
export async function drawCard(card: Card, site: string): Promise<Uint8Array> {
  await start();
  const accent = card.accent ?? C.accent;
  const long = card.title.length > 36;
  const el = h(
    "div",
    // Satori adds the padding to the size.
    { width: 1200 - 160, height: 630 - 144, flexDirection: "column", justifyContent: "space-between", padding: "64px 80px 80px", position: "relative", backgroundColor: C.bg, color: C.fg, fontFamily: "Inter" },
    [
      h("div", { alignItems: "center", fontSize: 30, color: C.muted }, [h("img", { marginRight: 18 }, undefined, { src: logo, width: 52, height: 45 }), site]),
      h("div", { flexDirection: "column" }, [
        h("div", { fontSize: long ? 60 : 78, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.08 }, card.title),
        card.description ? h("div", { marginTop: 24, fontSize: 32, lineHeight: 1.35, color: C.muted }, card.description) : null,
        card.tags
          ? h(
              "div",
              { marginTop: 36 },
              card.tags.map((t) => h("div", { marginRight: 14, padding: "8px 20px", fontSize: 24, color: C.fg, backgroundColor: C.panel, border: `2px solid ${C.border}`, borderRadius: 999 }, t)),
            )
          : null,
      ]),
      h("div", { position: "absolute", left: 0, bottom: 0, width: 1200, height: 12, backgroundColor: accent }),
    ],
  );
  const svg = await satori(el as never, {
    width: 1200,
    height: 630,
    fonts: FONTS,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}
