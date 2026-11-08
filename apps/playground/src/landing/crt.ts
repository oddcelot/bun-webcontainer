// The landing page's CRT: a small monitor (index.html, #landing .crt) showing a drawing of the playground, through a CRT
// shader. "Open the playground" zooms the page into its screen while the shader settles to a plain pass-through, then
// fades the screen out over the real playground (src/entry.ts).
//
// The fragment shader is the "Serenity Shader" from https://github.com/gingerbeardman/webgl-crt-shader
// (CRTShader.js), MIT licensed, Copyright (c) Matt Sephton (gingerbeardman). Unchanged apart from the varyings.

const VERTEX = /* glsl */ `
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  uniform sampler2D tDiffuse;
  uniform float scanlineIntensity;
  uniform float scanlineCount;
  uniform float time;
  uniform float yOffset;
  uniform float brightness;
  uniform float contrast;
  uniform float saturation;
  uniform float bloomIntensity;
  uniform float bloomThreshold;
  uniform float rgbShift;
  uniform float adaptiveIntensity;
  uniform float vignetteStrength;
  uniform float curvature;
  uniform float flickerStrength;

  varying vec2 vUv;

  const float PI = 3.14159265;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  const float BLOOM_THRESHOLD_FACTOR = 0.5;
  const float BLOOM_FACTOR_MULT = 1.5;
  const float RGB_SHIFT_SCALE = 0.005;
  const float RGB_SHIFT_INTENSITY = 0.08;

  vec2 curveRemapUV(vec2 uv, float curvature) {
    vec2 coords = uv * 2.0 - 1.0;
    float curveAmount = curvature * 0.25;
    float dist = dot(coords, coords);
    coords = coords * (1.0 + dist * curveAmount);
    return coords * 0.5 + 0.5;
  }

  vec4 sampleBloom(sampler2D tex, vec2 uv, float radius, vec4 centerSample) {
    vec2 o = vec2(radius);
    vec4 c = centerSample * 0.4;
    vec4 cross = (
      texture2D(tex, uv + vec2(o.x, 0.0)) +
      texture2D(tex, uv - vec2(o.x, 0.0)) +
      texture2D(tex, uv + vec2(0.0, o.y)) +
      texture2D(tex, uv - vec2(0.0, o.y))
    ) * 0.15;
    return c + cross;
  }

  float vignetteApprox(vec2 uv, float strength) {
    vec2 vigCoord = uv * 2.0 - 1.0;
    float dist = max(abs(vigCoord.x), abs(vigCoord.y));
    return 1.0 - dist * dist * strength;
  }

  void main() {
    vec2 uv = vUv;
    if (curvature > 0.001) {
      uv = curveRemapUV(uv, curvature);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
    }
    vec4 pixel = texture2D(tDiffuse, uv);
    if (bloomIntensity > 0.001) {
      float pixelLum = dot(pixel.rgb, LUMA);
      float bloomThresholdHalf = bloomThreshold * BLOOM_THRESHOLD_FACTOR;
      if (pixelLum > bloomThresholdHalf) {
        vec4 bloomSample = sampleBloom(tDiffuse, uv, 0.005, pixel);
        bloomSample.rgb *= brightness;
        float bloomLum = dot(bloomSample.rgb, LUMA);
        float bloomFactor = bloomIntensity * max(0.0, (bloomLum - bloomThreshold) * BLOOM_FACTOR_MULT);
        pixel.rgb += bloomSample.rgb * bloomFactor;
      }
    }
    if (rgbShift > 0.005) {
      float shift = rgbShift * RGB_SHIFT_SCALE;
      pixel.r += texture2D(tDiffuse, vec2(uv.x + shift, uv.y)).r * RGB_SHIFT_INTENSITY;
      pixel.b += texture2D(tDiffuse, vec2(uv.x - shift, uv.y)).b * RGB_SHIFT_INTENSITY;
    }
    pixel.rgb *= brightness;
    float luminance = dot(pixel.rgb, LUMA);
    pixel.rgb = (pixel.rgb - 0.5) * contrast + 0.5;
    pixel.rgb = mix(vec3(luminance), pixel.rgb, saturation);
    float lightingMask = 1.0;
    if (scanlineIntensity > 0.001) {
      float scanlineY = (uv.y + yOffset) * scanlineCount;
      float scanlinePattern = abs(sin(scanlineY * PI));
      float adaptiveFactor = 1.0;
      if (adaptiveIntensity > 0.001) {
        float yPattern = sin(uv.y * 30.0) * 0.5 + 0.5;
        adaptiveFactor = 1.0 - yPattern * adaptiveIntensity * 0.2;
      }
      lightingMask *= 1.0 - scanlinePattern * scanlineIntensity * adaptiveFactor;
    }
    if (flickerStrength > 0.001) {
      lightingMask *= 1.0 + sin(time * 110.0) * flickerStrength;
    }
    if (vignetteStrength > 0.001) {
      lightingMask *= vignetteApprox(uv, vignetteStrength);
    }
    pixel.rgb *= lightingMask;
    gl_FragColor = pixel;
  }
`;

type Params = {
  scanlineIntensity: number;
  adaptiveIntensity: number;
  brightness: number;
  contrast: number;
  saturation: number;
  bloomIntensity: number;
  bloomThreshold: number;
  rgbShift: number;
  vignetteStrength: number;
  curvature: number;
  flickerStrength: number;
};

/** The monitor's look (close to the shader's demo, a little more curved for a small screen). */
const CRT: Params = {
  scanlineIntensity: 0.5,
  adaptiveIntensity: 0.3,
  brightness: 1.3,
  contrast: 1.05,
  saturation: 1.1,
  bloomIntensity: 0.5,
  bloomThreshold: 0.5,
  rgbShift: 1,
  vignetteStrength: 0.35,
  curvature: 0.25,
  flickerStrength: 0.01,
};

/** Every effect off: the shader passes the drawing through unchanged, so it can hand over to the real page. */
const BASELINE: Params = {
  scanlineIntensity: 0,
  adaptiveIntensity: 0,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  bloomIntensity: 0,
  bloomThreshold: 0.5,
  rgbShift: 0,
  vignetteStrength: 0,
  curvature: 0,
  flickerStrength: 0,
};

const CODE = [
  [["k", "const "], ["v", "server"], ["p", " = "], ["t", "Bun"], ["p", "."], ["f", "serve"], ["p", "({"]],
  [["p", "  "], ["v", "routes"], ["p", ": {"]],
  [["p", "    "], ["s", '"/"'], ["p", ": () => "], ["k", "new "], ["t", "Response"], ["p", "("], ["s", '"Hello from Bun!"'], ["p", "),"]],
  [["p", "    "], ["s", '"/api/time"'], ["p", ": () =>"]],
  [["p", "      "], ["t", "Response"], ["p", "."], ["f", "json"], ["p", "({ "], ["v", "now"], ["p", ": "], ["k", "new "], ["t", "Date"], ["p", "() }),"]],
  [["p", "  },"]],
  [["p", "});"]],
  [],
  [["t", "console"], ["p", "."], ["f", "log"], ["p", "("], ["s", "`Listening on ${"], ["v", "server"], ["p", "."], ["v", "url"], ["s", "}`"], ["p", ");"]],
] as const;
const FILES = ["client.ts", "index.html", "index.ts", "package.json", "styles.css", "util.ts"];

/** The playground's colors from the active theme (theme.ts's variables), with style.css's dark defaults. */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    canvas: read("--canvas", "#171717"),
    panel: read("--panel", "#0a0a0a"),
    fg: read("--fg", "#e5e5e5"),
    muted: read("--muted", "#8a8a8a"),
    border: read("--border", "#2a2a2a"),
    accent: read("--accent", "#3b82f6"),
  };
}
const SYNTAX: Record<string, string> = { k: "#ff678d", v: "#ffca00", t: "#ffa359", f: "#9d6afb", s: "#5ecc71", p: "#a3a3a3" };

/**
 * The playground, drawn in its own layout (header, file tree, editor, preview and console) at `k` canvas pixels per CSS
 * pixel of a `w` × `h` window. `typed` is how many characters of the code are shown, for the typing animation.
 */
function drawPlayground(g: CanvasRenderingContext2D, w: number, h: number, k: number, typed: number, time: number) {
  const c = themeColors();
  const box = (x: number, y: number, bw: number, bh: number, fill: string) => {
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(x * k, y * k, bw * k, bh * k, 8 * k);
    g.fill();
  };
  const text = (s: string, x: number, y: number, color: string, size = 13, font = "ui-sans-serif, system-ui, sans-serif") => {
    g.fillStyle = color;
    g.font = `${size * k}px ${font}`;
    g.fillText(s, x * k, y * k);
    return g.measureText(s).width / k;
  };
  g.fillStyle = c.canvas;
  g.fillRect(0, 0, w * k, h * k);
  // Header: logo, title, project, Run.
  g.fillStyle = "#fbf0df";
  g.beginPath();
  g.arc(22 * k, 20 * k, 9 * k, 0, Math.PI * 2);
  g.fill();
  text("Bun playground", 40, 25, c.fg, 13);
  box(108, 7, 120, 26, c.panel);
  text("Demo", 118, 25, c.fg, 12);
  box(238, 7, 70, 26, c.panel);
  text("▶ Run", 250, 25, c.fg, 12);
  box(w - 70, 7, 62, 26, c.panel);
  text("Share", w - 58, 25, c.fg, 12);
  // Panels.
  const top = 42;
  const bottom = h - 32;
  const side = Math.min(170, w * 0.14);
  const right = w * 0.42;
  const editorX = 8 + side + 8;
  const editorW = w - right - editorX - 8;
  box(8, top, side, bottom - top, c.panel);
  box(editorX, top, editorW, bottom - top, c.panel);
  box(w - right, top, right - 8, (bottom - top) * 0.45, c.panel);
  box(w - right, top + (bottom - top) * 0.45 + 8, right - 8, (bottom - top) * 0.55 - 8, c.panel);
  // File tree.
  FILES.forEach((name, i) => {
    if (name === "index.ts") box(14, top + 52 + i * 24, side - 12, 22, c.border);
    text(name, 26, top + 68 + i * 24, c.fg, 13);
  });
  box(14, top + 8, side - 12, 26, c.canvas);
  text("Search...", 22, top + 26, c.muted, 12);
  // Editor: a tab, line numbers and the code, typed out.
  text("index.ts", editorX + 14, top + 24, c.fg, 13);
  g.fillStyle = c.accent;
  g.fillRect((editorX + 8) * k, (top + 32) * k, 70 * k, 2 * k);
  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  let left = typed;
  let cursor: [number, number] | null = null;
  CODE.forEach((line, i) => {
    const y = top + 70 + i * 22;
    text(String(i + 1), editorX + 18, y, c.muted, 14, mono);
    let x = editorX + 52;
    for (const [kind, s] of line) {
      if (left <= 0) break;
      const shown = s.slice(0, left);
      left -= s.length;
      x += text(shown, x, y, SYNTAX[kind], 14, mono);
    }
    if (left >= 0 || !cursor) cursor = [x, y];
    left -= 1; // the newline
  });
  if (cursor && Math.floor(time * 2) % 2 === 0) {
    g.fillStyle = c.fg;
    g.fillRect(cursor[0] * k + k, (cursor[1] - 14) * k, 2 * k, 18 * k);
  }
  // Preview and console.
  const px = w - right + 16;
  text("Hello from Bun!", px, top + 70, c.fg, 16);
  const consoleTop = top + (bottom - top) * 0.45 + 8;
  text("Console", px, consoleTop + 24, c.fg, 13);
  text("[run] index.ts", px, consoleTop + 54, SYNTAX.f, 13, mono);
  if (typed >= TOTAL) text("Listening on http://localhost:3000/", px, consoleTop + 74, c.fg, 13, mono);
  text("Ready", 22, h - 11, c.muted, 12);
}
const TOTAL = CODE.reduce((n, line) => n + line.reduce((m, [, s]) => m + s.length, 0) + 1, 0);

function compile(gl: WebGLRenderingContext) {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return (name: string) => gl.getUniformLocation(program, name);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

export type Crt = {
  /** Zooms the page into the screen, calls `swap` once it fills the window, and fades out once `ready` settles. */
  zoom(swap: () => void, ready: Promise<unknown>): Promise<void>;
};

/** Starts the monitor in `screen` (a .crt-screen element holding a canvas), or null without WebGL. */
export function startCrt(screen: HTMLElement): Crt | null {
  const canvas = screen.querySelector("canvas")!;
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  let uniform: ReturnType<typeof compile>;
  try {
    uniform = compile(gl);
  } catch (error) {
    console.warn("[crt]", error);
    return null;
  }
  const scene = document.createElement("canvas");
  const g = scene.getContext("2d")!;
  // The drawing is laid out like the playground in this window, so the zoom ends on roughly the real layout.
  let win = { w: innerWidth, h: innerHeight };
  const sceneScale = () => Math.min(1, 960 / win.w) * Math.min(devicePixelRatio, 2);
  // The screen's aspect is the window's: zoomed in, it fills the window exactly.
  const fit = () => {
    win = { w: innerWidth, h: innerHeight };
    screen.style.setProperty("--crt-aspect", `${win.w} / ${win.h}`);
  };
  fit();
  addEventListener("resize", fit);

  let params = { ...CRT };
  let scanlines = 240;
  const start = performance.now();
  let visible = true;
  let zooming = false;
  let frame = 0;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !frame) frame = requestAnimationFrame(render);
  });
  observer.observe(screen);

  function render(now: number) {
    frame = 0;
    const time = (now - start) / 1000;
    const k = sceneScale();
    const sw = Math.round(win.w * k);
    const sh = Math.round(win.h * k);
    if (scene.width !== sw || scene.height !== sh) Object.assign(scene, { width: sw, height: sh });
    // Types the code, holds it for a few seconds, then starts again; done typing once the zoom starts.
    const cycle = time % 14;
    const typed = zooming ? TOTAL : Math.min(TOTAL, Math.floor(Math.max(0, cycle - 0.8) * 28));
    drawPlayground(g, win.w, win.h, k, typed, time);
    if (!zooming) {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio, 2);
      const cw = Math.round(box.width * dpr);
      const ch = Math.round(box.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) Object.assign(canvas, { width: cw, height: ch });
      // About one scanline per 2.5 device pixels, so they don't alias into moiré.
      scanlines = Math.max(60, Math.round(ch / 2.5));
    }
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, scene);
    for (const [name, value] of Object.entries(params)) gl!.uniform1f(uniform(name), value);
    gl!.uniform1f(uniform("scanlineCount"), scanlines);
    gl!.uniform1f(uniform("time"), time);
    gl!.uniform1f(uniform("yOffset"), (time * 0.02) % 1);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    if ((visible || zooming) && !document.hidden) frame = requestAnimationFrame(render);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !frame) frame = requestAnimationFrame(render);
  });
  frame = requestAnimationFrame(render);

  return {
    async zoom(swap, ready) {
      zooming = true;
      const landing = document.getElementById("landing")!;
      // Freeze the scroll position (without the scrollbar's width changing the layout), then measure.
      const lockScroll = (e: Event) => e.preventDefault();
      addEventListener("wheel", lockScroll, { passive: false });
      addEventListener("touchmove", lockScroll, { passive: false });
      const rect = screen.getBoundingClientRect();
      const box = landing.getBoundingClientRect();
      const scale = Math.max(win.w / rect.width, win.h / rect.height);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Draw at the size the screen ends up at, from the start.
      const dpr = Math.min(devicePixelRatio, 2);
      Object.assign(canvas, { width: Math.round(win.w * dpr), height: Math.round(win.h * dpr) });
      scanlines = Math.max(60, Math.round((rect.height * dpr) / 2.5));
      landing.style.transformOrigin = `${cx - box.left}px ${cy - box.top}px`;
      landing.style.willChange = "transform";
      const duration = 1300;
      const motion = landing.animate(
        [{ transform: "none" }, { transform: `translate(${win.w / 2 - cx}px, ${win.h / 2 - cy}px) scale(${scale})` }],
        { duration, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
      );
      // The shader settles while the screen grows: on the way in it is still a CRT, filling the window it is flat.
      const t0 = performance.now();
      for (let t = 0; t < 1; ) {
        t = Math.min(1, (((await nextFrame()) - t0) / duration - 0.15) / 0.85);
        const e = ease(Math.max(0, t));
        params = Object.fromEntries(Object.entries(CRT).map(([key, from]) => [key, from + (BASELINE[key as keyof Params] - from) * e])) as Params;
      }
      await motion.finished;
      // The screen fills the window: move it onto the page as an overlay, swap the landing page for the playground
      // underneath, and fade out once the playground has rendered.
      const overlay = document.createElement("div");
      overlay.className = "crt-overlay";
      overlay.append(canvas);
      document.body.append(overlay);
      removeEventListener("wheel", lockScroll);
      removeEventListener("touchmove", lockScroll);
      swap();
      await Promise.race([ready, new Promise((r) => setTimeout(r, 10_000))]);
      await nextFrame();
      await overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: "ease-out", fill: "forwards" }).finished;
      cancelAnimationFrame(frame);
      frame = 0;
      visible = zooming = false;
      observer.disconnect();
      removeEventListener("resize", fit);
      overlay.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
