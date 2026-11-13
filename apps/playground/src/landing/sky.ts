// The sky in the landing page's window (index.html, #landing .window): clouds drifting past, drawn a few art pixels
// at a time and reduced to five colors with ordered (Bayer) dithering, like the kitchen's props
// (scripts/landing-art.ts). In the page's light scheme the colors follow the visitor's clock: dawn, day, dusk. In its
// dark one (html[data-scheme], style.css #landing) the kitchen is in its night colors, and the sky is the night's.

// Dark to light.
const SKIES = {
  dawn: ["#f39a8b", "#fab79b", "#fdd2b1", "#ffe8cf", "#fff9ec"],
  day: ["#63a4e8", "#8cbff2", "#b8d9f8", "#e2f0fd", "#ffffff"],
  dusk: ["#7f68bd", "#bd7fc4", "#ee98b1", "#ffc3a8", "#ffebca"],
  night: ["#1c224e", "#2a326c", "#46509a", "#8a97dc", "#f4f6ff"],
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The sky of an hour; the night one is the dark scheme's, so by day the small hours are dawn and the late ones dusk. */
function sky(hour: number) {
  if (hour < 8) return SKIES.dawn;
  if (hour < 17) return SKIES.day;
  return SKIES.dusk;
}

/** A repeatable pseudo-random value in [0, 1) for a lattice point. */
function hash(x: number, y: number) {
  let n = Math.imul((x * 374761393 + y * 668265263) | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise: the lattice's values, blended. */
function noise(x: number, y: number) {
  const [xi, yi] = [Math.floor(x), Math.floor(y)];
  const [u, v] = [x - xi, y - yi].map((t) => t * t * (3 - 2 * t)) as [number, number];
  const top = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * u;
  const bottom = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;
  return top + (bottom - top) * v;
}

/** Draws the sky in `canvas` (at its width and height attributes) and keeps the clouds moving while it is in view. */
export function startSky(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  let colors: number[][] = [];
  let night = false;
  const pick = () => {
    const now = document.documentElement.dataset.scheme === "dark" ? SKIES.night : sky(new Date().getHours());
    colors = now.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
    night = now === SKIES.night;
  };
  pick();
  const image = context.createImageData(width, height);
  // The sun, or the moon.
  const [sunX, sunY, sunR] = [width * 0.74, height * 0.3, 7.5];

  function draw(time: number) {
    const drift = time / 9000;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // Wide, flat clouds in three sizes, the small ones moving faster; the sky lightens toward the horizon.
        const cloud = noise(x / 34 + drift, y / 15) * 0.55 + noise(x / 15 + drift * 1.6, y / 7 + 9) * 0.3 + noise(x / 6 + drift * 2.4, y / 3 + 31) * 0.15;
        let light = (y / height) * 0.3 + Math.max(0, cloud - 0.45) * 2.6;
        if (Math.hypot(x - sunX, y - sunY) < sunR) light = 1;
        else if (night && hash(x, y) > 0.992 && cloud < 0.45) light = 0.8;
        const level = Math.min(1, light) * (colors.length - 1);
        const [r, g, b] = colors[Math.min(colors.length - 1, Math.floor(level + (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16))] as [number, number, number];
        image.data.set([r, g, b, 255], (y * width + x) * 4);
      }
    context!.putImageData(image, 0, 0);
  }

  draw(0);
  // The scheme changed: the other sky, at once (the clouds may be standing still).
  new MutationObserver(() => {
    pick();
    draw(performance.now());
  }).observe(document.documentElement, { attributeFilter: ["data-scheme"] });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Eight frames a second: the clouds move in steps, like the rest of the page.
  let timer = 0;
  new IntersectionObserver(([entry]) => {
    clearInterval(timer);
    if (entry?.isIntersecting) timer = window.setInterval(() => draw(performance.now()), 125);
  }).observe(canvas);
}
