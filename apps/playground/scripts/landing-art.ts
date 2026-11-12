// Draws the landing page's kitchen (src/landing/art/*.png; index.html, style.css #landing): each prop is a few shapes,
// shaded from the top left and reduced to a short color ramp with ordered (Bayer) dithering, then outlined in ink, so
// they all share one light, one palette and one pixel size. Run `bun run landing-art` after changing one; the outputs
// are committed, each with a `-night` twin for the page's dark scheme: the same pixels by moonlight (`night`).
// `--preview <file.png>` also writes a contact sheet of them all, and `--night <hex>...` prints colors by moonlight,
// for the ones style.css paints itself (the window's frame, the monitor's case).
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const out = new URL("../src/landing/art/", import.meta.url).pathname;

/** The outline, and the page's text color (style.css #landing --fg). */
const INK = "#5b3a2e";
// Ramps run dark to light.
const BAMBOO = ["#96602f", "#b98143", "#d6a25c", "#ecc384", "#f8dfae"];
const WOOD = ["#9c6238", "#bb7b4b", "#d59861", "#e8b47d", "#f5d2a2"];
const DARK_WOOD = ["#74452a", "#8f5a36", "#a97145"];
const ENAMEL = ["#c93f72", "#ea5f92", "#ff86b4", "#ffb3cf", "#ffdbe8"];
const METAL = ["#7f8898", "#a5afbd", "#cbd3dd", "#e8edf3", "#ffffff"];
const LEAF = ["#2f6b3a", "#4a8c44", "#70b055", "#9fd168", "#d0ee98"];
const CLAY = ["#a55034", "#c66c47", "#df8c61", "#f1b088"];
const CERAMIC = ["#7fa9d0", "#a3c6e4", "#c6dff2", "#e6f2fb"];
/** For `mark`: the cursors, the speaker. */
const CREAM = ["#ecd2a6", "#fffaf0", "#fffaf0"];
const GLASS = ["#b9d8de", "#d5eaee", "#ecf7f8", "#ffffff"];

/** A color channel by moonlight: dimmed, the blue least, over a deep blue. */
const moon = (r: number, g: number, b: number) => [r * 0.25 + 8, g * 0.26 + 8, b * 0.4 + 22].map(Math.round) as [number, number, number];

type Inside = (x: number, y: number) => boolean;
type Shade = number | ((x: number, y: number) => number);

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** The ordered-dither threshold of a pixel, in (0, 1). */
const threshold = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
/** A repeatable pseudo-random value in [0, 1) for a pixel. */
function hash(x: number, y: number, seed = 0) {
  let n = Math.imul((x * 374761393 + y * 668265263 + seed * 974711) | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** The light on a cylinder seen from the side, across its width (u: -1 at the left edge, 1 at the right). */
const round = (u: number) => clamp(0.82 - 0.6 * (u + 0.35) ** 2);

const ellipse =
  (cx: number, cy: number, rx: number, ry: number): Inside =>
  (x, y) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
/** A rectangle, both corners included. */
const rect =
  (x0: number, y0: number, x1: number, y1: number): Inside =>
  (x, y) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;
/** A rectangle with its corners cut round by `r` pixels. */
const rounded =
  (x0: number, y0: number, x1: number, y1: number, r: number): Inside =>
  (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
    const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
    return dx * dx + dy * dy <= r * r + 1;
  };

class Sprite {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }
  set(x: number, y: number, hex: string, alpha = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const n = parseInt(hex.slice(1), 16);
    this.data.set([n >> 16, (n >> 8) & 255, n & 255, alpha], (y * this.w + x) * 4);
  }
  opaque(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.data[(y * this.w + x) * 4 + 3]! > 0;
  }
  /** Paints the pixels `inside` from `ramp` (dark to light) by `shade` (0 to 1), dithering between neighbors. */
  fill(inside: Inside, ramp: string[], shade: Shade = 0.5) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (!inside(x, y)) continue;
        const v = clamp(typeof shade === "number" ? shade : shade(x, y)) * (ramp.length - 1);
        this.set(x, y, ramp[Math.min(ramp.length - 1, Math.floor(v + threshold(x, y)))]!);
      }
    return this;
  }
  /** Draws an ink line around everything painted so far. */
  outline(ink = INK) {
    const edge: [number, number][] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (!this.opaque(x, y) && (this.opaque(x - 1, y) || this.opaque(x + 1, y) || this.opaque(x, y - 1) || this.opaque(x, y + 1))) edge.push([x, y]);
    for (const [x, y] of edge) this.set(x, y, ink);
    return this;
  }
  /** A copy of the pixels `keep` picks. */
  only(keep: Inside) {
    const copy = new Sprite(this.w, this.h);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) if (keep(x, y)) copy.data.set(this.data.subarray((y * this.w + x) * 4, (y * this.w + x) * 4 + 4), (y * this.w + x) * 4);
    return copy;
  }
  /** Draws `other` over this one at (ox, oy), `scale` times its size. */
  draw(other: Sprite, ox: number, oy: number, scale = 1) {
    for (let y = 0; y < other.h * scale; y++)
      for (let x = 0; x < other.w * scale; x++) {
        const i = (Math.floor(y / scale) * other.w + Math.floor(x / scale)) * 4;
        if (!other.data[i + 3] || ox + x >= this.w || oy + y >= this.h) continue;
        const o = ((oy + y) * this.w + ox + x) * 4;
        const a = other.data[i + 3]! / 255;
        for (let c = 0; c < 3; c++) this.data[o + c] = Math.round(other.data[i + c]! * a + this.data[o + c]! * (1 - a));
        this.data[o + 3] = Math.max(this.data[o + 3]!, other.data[i + 3]!);
      }
    return this;
  }
  /** A copy by moonlight; `strength` under 1 keeps some of the day's light (steam, which glows). */
  night(strength = 1) {
    const copy = new Sprite(this.w, this.h);
    copy.data.set(this.data);
    for (let i = 0; i < copy.data.length; i += 4) {
      const lit = moon(copy.data[i]!, copy.data[i + 1]!, copy.data[i + 2]!);
      for (let c = 0; c < 3; c++) copy.data[i + c] = Math.round(copy.data[i + c]! * (1 - strength) + lit[c]! * strength);
    }
    return copy;
  }
  png() {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) raw.set(this.data.subarray(y * this.w * 4, (y + 1) * this.w * 4), y * (this.w * 4 + 1) + 1);
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), body])), 0);
      return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.w, 0);
    header.writeUInt32BE(this.h, 4);
    header.set([8, 6, 0, 0, 0], 8); // 8 bits a channel, RGBA
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
}

/** Frames side by side, for a CSS `steps()` animation. */
function sheet(frames: Sprite[]) {
  const all = new Sprite(frames[0]!.w * frames.length, frames[0]!.h);
  frames.forEach((frame, i) => all.draw(frame, i * frame.w, 0));
  return all;
}

/** The wall's backsplash: four tiles, cream and peach in a checker, each with a lit top left and a grout line. */
function tiles() {
  const size = 16;
  const s = new Sprite(size * 2, size * 2);
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const peach = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 1;
      const [tx, ty] = [x % size, y % size];
      const grout = tx === size - 1 || ty === size - 1;
      const lit = tx === 0 || ty === 0;
      s.set(x, y, grout ? "#f0d9b4" : peach ? (lit ? "#ffe9df" : "#ffdccd") : lit ? "#fffdf6" : "#fff4de");
    }
  return s;
}

/** The counter, a strip that repeats sideways: a butcher-block top seen from above, its front edge, and a shadow. */
function counter() {
  const s = new Sprite(96, 26);
  const wrap = (x: number) => ((x % s.w) + s.w) % s.w;
  // The top: boards 24 wide with staggered ends, and a grain of long streaks.
  s.fill(
    rect(0, 0, s.w - 1, 13),
    WOOD,
    (x, y) => 0.72 + (hash(Math.floor(wrap(x + (y >> 2) * 7) / 6), y, 3) - 0.5) * 0.3 - (wrap(x + (y > 6 ? 12 : 0)) % 24 === 0 ? 0.3 : 0) - (y === 7 ? 0.12 : 0),
  );
  s.fill(rect(0, 0, s.w - 1, 0), WOOD, 1);
  // The front edge, darker, with the boards' end grain.
  s.fill(rect(0, 14, s.w - 1, 21), WOOD, (x, y) => 0.3 - (y - 14) * 0.03 + (hash(wrap(x) >> 1, 0, 5) - 0.5) * 0.2);
  s.fill(rect(0, 14, s.w - 1, 14), WOOD, 0.5);
  s.fill(rect(0, 22, s.w - 1, 22), [INK]);
  // The shadow under it, thinning out.
  for (let y = 23; y < s.h; y++) for (let x = 0; x < s.w; x++) if (threshold(x, y) < 0.75 - (y - 23) * 0.3) s.set(x, y, INK, 46);
  return s;
}

/**
 * A bamboo steamer, two baskets high, open on top. In two layers, so a dumpling can sit in it: `back` is all of it,
 * `front` only the wall in front of the opening.
 */
function steamer() {
  const s = new Sprite(68, 42);
  const [cx, rx, ry, tall] = [33.5, 31, 5, 13];
  const front = (cy: number, x: number, r = ry, wide = rx) => cy + r * Math.sqrt(Math.max(0, 1 - ((x - cx) / wide) ** 2));
  const basket = (cy: number) => {
    s.fill(
      (x, y) => Math.abs(x - cx) <= rx && y >= cy && y <= front(cy + tall, x),
      BAMBOO,
      (x, y) => {
        const d = y - front(cy, x);
        const hoop = d < 3.5 || d > tall - 3.5;
        const seam = Math.abs(d - 3.5) < 0.5 || Math.abs(d - (tall - 3.5)) < 0.5;
        return round((x - cx) / rx) + (hoop ? 0.16 : (x + 2) % 5 === 0 ? -0.16 : 0) - (seam ? 0.3 : 0);
      },
    );
  };
  basket(6 + tall);
  basket(6);
  // Where the baskets meet.
  s.fill((x, y) => Math.abs(x - cx) <= rx && y === Math.round(front(6 + tall, x)), [INK]);
  s.fill(ellipse(cx, 6, rx, ry), BAMBOO, 0.95);
  s.fill(ellipse(cx, 6, rx - 3, ry - 1.5), BAMBOO, (x, y) => 0.1 + (y - 3) * 0.05);
  s.outline();
  return { back: s, front: s.only((x, y) => Math.abs(x - cx) > rx - 3 || y > front(6, x, ry - 1.5, rx - 3)) };
}

/** An enamel pot with its lid on. */
function pot() {
  const s = new Sprite(60, 36);
  const cx = 29.5;
  // Handles, then the body over them.
  s.fill(rounded(3, 16, 56, 20, 2), DARK_WOOD, (_, y) => 0.9 - (y - 16) * 0.2);
  s.fill(rounded(9, 12, 50, 33, 6), ENAMEL, (x, y) => round((x - cx) / 21) - (y - 12) * 0.008);
  s.fill(rect(13, 16, 14, 26), ENAMEL, 1);
  s.fill(rect(8, 11, 51, 13), ENAMEL, (x) => round((x - cx) / 22) + 0.2);
  // The lid: a low dome and a knob.
  s.fill(
    (x, y) => y <= 10 && ellipse(cx, 10.5, 20, 7)(x, y),
    ENAMEL,
    (x, y) => round((x - cx) / 20) + (10 - y) * 0.03,
  );
  s.fill(rounded(26, 1, 33, 4, 1), DARK_WOOD, (_, y) => 1 - (y - 1) * 0.3);
  return s.outline();
}

/** Steam rising and thinning out, as a loop of frames: puffs that drift up, swell and fade. */
function steam(frames = 8) {
  const [w, h] = [30, 40];
  return sheet(
    Array.from({ length: frames }, (_, f) => {
      const s = new Sprite(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let cover = 0;
          let lit = 0;
          for (let puff = 0; puff < 4; puff++) {
            const t = (f / frames + puff / 4) % 1; // 0 at the pot, 1 at the top
            const px = w / 2 + Math.sin(t * 5 + puff * 2.1) * (2 + t * 6);
            const py = h - 4 - t * (h - 10);
            const r = 4 + t * 7;
            const d = Math.hypot(x - px, (y - py) * 1.15) / r;
            const c = (1 - d) * (1 - t * t) * 2.6;
            if (c > cover) [cover, lit] = [c, (px - x + (py - y)) / r];
          }
          if (cover > threshold(x, y) + 0.25) s.set(x, y, lit > -0.25 ? "#ffffff" : "#d3deea");
        }
      return s;
    }),
  );
}

/** A crock of utensils: a wooden spoon, a whisk and a spatula. */
function crock() {
  const s = new Sprite(36, 62);
  // Spoon.
  s.fill(rect(9, 14, 11, 40), WOOD, (x) => 0.9 - (x - 9) * 0.3);
  s.fill(ellipse(10, 9, 4.6, 6.4), WOOD, (x, y) => 0.85 - ((x - 8) ** 2 + (y - 7) ** 2) * 0.02);
  // Whisk: a handle, and wires as a ring with a spine.
  s.fill(rect(17, 24, 18, 40), METAL, (x) => (x === 17 ? 0.8 : 0.3));
  s.fill((x, y) => (ellipse(17.5, 14, 5.4, 10.4)(x, y) && !ellipse(17.5, 14, 4.2, 9.2)(x, y)) || (x >= 17 && x <= 18 && y >= 4 && y <= 24 && y % 2 === 0), METAL, (x) => 0.75 - (x - 12) * 0.05);
  // Spatula.
  s.fill(rect(25, 18, 26, 40), WOOD, (x) => (x === 25 ? 0.8 : 0.4));
  s.fill(rounded(21, 3, 30, 18, 3), ENAMEL, (x, y) => 0.75 - (x - 21) * 0.04 - (y - 3) * 0.01);
  // The crock, with a band.
  s.fill(rounded(5, 36, 30, 59, 4), CERAMIC, (x, y) => round((x - 17.5) / 13) + 0.15 - (y > 42 && y < 46 ? 0.55 : 0));
  s.fill(rect(4, 34, 31, 36), CERAMIC, (x) => round((x - 17.5) / 14) + 0.3);
  return s.outline();
}

/** A pot of basil: a mound of overlapping leaves, each lit from the top left. */
function basil() {
  const s = new Sprite(50, 54);
  const cx = 24.5;
  const half = (y: number) => 12 - (y - 36) * 0.22;
  s.fill((x, y) => y >= 36 && y <= 50 && Math.abs(x - cx) <= half(y), CLAY, (x, y) => round((x - cx) / half(y)) + 0.05);
  s.fill(rect(10, 32, 39, 35), CLAY, (x, y) => round((x - cx) / 15) + (y === 32 ? 0.3 : 0.12));
  const leaves = Array.from({ length: 44 }, (_, i) => {
    const a = hash(i, 1, 9) * Math.PI * 2;
    const d = Math.sqrt(hash(i, 2, 9));
    return { x: cx + Math.cos(a) * d * 17, y: 18 + Math.sin(a) * d * 12, r: 3.5 + hash(i, 3, 9) * 3.5 };
  }).sort((p, q) => p.y - q.y);
  s.fill(
    (x, y) => leaves.some((l) => Math.hypot(x - l.x, y - l.y) <= l.r) && y < 34,
    LEAF,
    (x, y) => {
      const l = leaves.findLast((l) => Math.hypot(x - l.x, y - l.y) <= l.r)!;
      const facing = ((x - l.x) * 0.55 + (y - l.y) * 0.85) / l.r;
      return 0.5 - facing * 0.45 - ((x - cx) / 17 + (y - 18) / 12) * 0.22 + (hash(x, y, 4) - 0.5) * 0.12;
    },
  );
  return s.outline();
}

/** A rolling pin, lying down. */
function rollingPin() {
  const s = new Sprite(78, 16);
  const across = (y: number) => round((y - 7.5) / 6);
  s.fill(rounded(2, 5, 75, 10, 2), DARK_WOOD, (_, y) => across(y) + 0.1);
  s.fill(rounded(12, 2, 65, 13, 3), WOOD, (x, y) => across(y) + (hash(x >> 2, y, 6) - 0.5) * 0.12);
  return s.outline();
}

/** A shelf of jars: flour, coffee beans, pasta and sugar. */
function shelf() {
  const s = new Sprite(104, 46);
  const floor = 37;
  const jar = (x0: number, w: number, h: number, lid: string[], contents: string[], full: number) => {
    const [x1, top] = [x0 + w - 1, floor - h + 1];
    s.fill(rounded(x0, top + 3, x1, floor, 2), GLASS, (x) => 0.75 - ((x - x0) / w) * 0.6);
    s.fill(rounded(x0 + 1, floor - Math.round((h - 5) * full), x1 - 1, floor - 1, 1), contents, (x, y) => 0.8 - ((x - x0) / w) * 0.55 + (hash(x, y, x0) - 0.5) * 0.35);
    s.fill(rect(x0 + 2, top + 5, x0 + 2, floor - 3), GLASS, 1);
    s.fill(rect(x0 - 1, top, x1 + 1, top + 2), lid, (x, y) => 0.85 - ((x - x0) / w) * 0.5 - (y - top) * 0.1);
  };
  jar(8, 20, 27, DARK_WOOD, ["#ecdcc0", "#f8eedb", "#fffaf0"], 0.8);
  jar(34, 15, 20, ENAMEL, ["#6b3f2a", "#8a5637", "#a56c46"], 0.65);
  jar(55, 21, 31, DARK_WOOD, ["#e3a93f", "#f3c45e", "#ffdf8a"], 0.7);
  jar(82, 15, 18, LEAF.slice(1, 4), ["#f6c9d6", "#ffe3ea", "#ffffff"], 0.75);
  // The board, and a bracket under each end.
  s.fill(rect(1, floor + 1, s.w - 2, floor + 4), WOOD, (x, y) => 0.85 - (y - floor - 1) * 0.2 + (hash(x >> 2, y, 8) - 0.5) * 0.15);
  for (const x of [12, s.w - 17]) s.fill((px, py) => py > floor + 4 && py <= floor + 8 && px >= x && px <= x + 4 - (py - floor - 5), DARK_WOOD, 0.5);
  return s.outline();
}

/** The light switch on the wall: a plate with a lever, up for on. */
function lightSwitch(on: boolean) {
  const s = new Sprite(14, 20);
  s.fill(rounded(1, 1, 12, 18, 2), ["#d9bf95", "#f3e3c6", "#fffaf0"], (x, y) => 0.95 - (x - 1) * 0.04 - (y - 1) * 0.03);
  // A screw at each end, the slot, and the lever in it.
  for (const y of [3, 16]) s.fill(rect(6, y, 7, y), ["#b89a6c"]);
  s.fill(rect(5, 6, 8, 13), [INK]);
  const top = on ? 5 : 10;
  s.fill(rect(5, top, 8, top + 4), ENAMEL, (_, y) => 0.9 - (y - top) * 0.2);
  return s.outline();
}

/** The header's sound button: a speaker, with waves in pink when on and a cross when off. */
function speaker(on: boolean) {
  const s = mark(["..............", "......o.......", ".....oo.......", ".ooooo........", ".ooooo........", ".ooooo........", ".....oo.......", "......o.......", ".............."], CREAM).outline();
  const pink = on
    ? [[9, 3], [9, 4], [9, 5], [11, 1], [12, 2], [12, 3], [12, 4], [12, 5], [12, 6], [11, 7]]
    : [[9, 3], [11, 3], [10, 4], [9, 5], [11, 5]];
  for (const [x, y] of pink) s.set(x!, y!, ENAMEL[2]!);
  return s;
}

/** A small mark drawn by hand, a row per string: `#` is a color (the enamel pink), `o` its highlight, `d` its shade. */
function mark(rows: string[], [shade, color, light] = [ENAMEL[0]!, ENAMEL[2]!, ENAMEL[4]!]) {
  const colors: Record<string, string> = { "#": color!, o: light!, d: shade! };
  const s = new Sprite(rows[0]!.length, rows.length);
  rows.forEach((row, y) => [...row].forEach((c, x) => colors[c] && s.set(x, y, colors[c])));
  return s;
}

const art: Record<string, Sprite> = {
  // The cards' list bullets.
  heart: mark([".#o.##.", "#o#####", "######d", ".####d.", "..##d..", "...d..."]),
  arrow: mark(["#...", "##..", "###.", "####", "##d.", "#d..", "d..."]),
  // The scheme switch: what a click brings, the moon by day and the sun by night.
  moon: mark(
    ["..........", "...####...", "..#o##....", ".#o##.....", ".####.....", ".####.....", ".#####..d.", "..######d.", "...###dd..", ".........."],
    [METAL[1]!, METAL[3]!, METAL[4]!],
  ).outline(),
  sun: mark(
    [".............", "......#......", "..#.......#..", "....#####....", "...##ooo##...", "...#o####d...", ".#.#o####d.#.", "...#o####d...", "...###ddd#...", "....#####....", "..#.......#..", "......#......", "............."],
    ["#e3a93f", "#f3c45e", "#ffdf8a"],
  ).outline(),
  "sound-on": speaker(true),
  "sound-off": speaker(false),
  switch: lightSwitch(true),
  tiles: tiles(),
  counter: counter(),
  "steamer-back": steamer().back,
  "steamer-front": steamer().front,
  pot: pot(),
  steam: steam(),
  crock: crock(),
  basil: basil(),
  "rolling-pin": rollingPin(),
  shelf: shelf(),
};

mkdirSync(out, { recursive: true });
// The bullets and the switch keep their colors at night.
const lit = new Set(["heart", "arrow", "moon", "sun", "sound-on", "sound-off"]);
for (const [name, sprite] of Object.entries(art)) {
  writeFileSync(`${out}${name}.png`, sprite.png());
  // At night the switch is off.
  const dark = name === "switch" ? lightSwitch(false) : sprite;
  if (!lit.has(name)) writeFileSync(`${out}${name}-night.png`, dark.night(name === "steam" ? 0.55 : 1).png());
}
// The page's cursors, in cream with the props' outline: an arrow, and a hand with a pink cuff over what can be clicked.
// A cursor is drawn at its file's size, so each is written at two art pixels a pixel, and at four for 2x screens.
// Their hot spots (the arrow's tip, the fingertip) are in style.css #landing.
const hand = mark(
  ["..............", ".....oo.......", ".....oo.......", ".....oo.......", ".....oo.......", ".....oooooo...", ".....oooooooo.", "..oo.oooooooo.", "..oooooooooood", "...ooooooooood", "...ooooooooood", "....ooooooood.", ".....ooooooo..", "..............", ".............."],
  CREAM,
);
// The cuff.
hand.fill(rect(5, 13, 11, 13), ENAMEL, 0.5);
const cursors: Record<string, Sprite> = {
  cursor: mark(
    ["...........", ".o.........", ".oo........", ".ooo.......", ".oooo......", ".ooooo.....", ".oooooo....", ".ooooooo...", ".oooooooo..", ".oooood....", ".oo.ood....", ".o...ood...", ".....ood...", "...........", "..........."],
    CREAM,
  ).outline(),
  pointer: hand.outline(),
};
for (const [name, sprite] of Object.entries(cursors))
  for (const [suffix, scale] of [["", 2], ["@2x", 4]] as const) writeFileSync(`${out}${name}${suffix}.png`, new Sprite(sprite.w * scale, sprite.h * scale).draw(sprite, 0, 0, scale).png());
console.log(`${Object.keys(art).length} sprites and ${Object.keys(cursors).length} cursors in ${out}`);

const colors = process.argv.indexOf("--night");
if (colors > 0)
  for (const hex of process.argv.slice(colors + 1)) {
    const n = parseInt(hex.slice(1), 16);
    console.log(hex, "#" + moon(n >> 16, (n >> 8) & 255, n & 255).map((c) => c.toString(16).padStart(2, "0")).join(""));
  }

const preview = process.argv.indexOf("--preview");
if (preview > 0) {
  const scale = 4;
  const sprites = Object.values(art);
  const page = new Sprite(Math.max(...sprites.map((s) => s.w)) * scale + 16, sprites.reduce((h, s) => h + s.h * scale + 8, 8));
  page.fill(() => true, ["#fff6e5"]);
  let y = 8;
  for (const sprite of sprites) {
    page.draw(sprite, 8, y, scale);
    y += sprite.h * scale + 8;
  }
  writeFileSync(process.argv[preview + 1]!, page.png());
}
