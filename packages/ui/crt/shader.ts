// A CRT monitor screen: a canvas that shows the playground (scene.ts) through a CRT shader, and can settle to a plain
// pass-through, so a zoom into it can end on (or hand over to) the real playground. The playground's landing page
// (apps/playground/src/landing/crt.ts) and the docs' "Open playground" button (apps/docs/src/crt-launch.ts) use it.
//
// The fragment shader is the "Serenity Shader" from https://github.com/gingerbeardman/webgl-crt-shader
// (CRTShader.js), MIT licensed, Copyright (c) 2025 Matt Sephton @gingerbeardman. Unchanged apart from the varyings.

import { drawPlayground, TOTAL } from "./scene.ts";

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

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/**
 * The transform that grows an element around `rect` (a screen inside it) until the screen fills the window, for a
 * transform-origin at the screen's center. `box` is the element's own rect.
 */
export function fillWindow(rect: DOMRect, box: DOMRect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const scale = Math.max(innerWidth / rect.width, innerHeight / rect.height);
  return {
    origin: `${cx - box.left}px ${cy - box.top}px`,
    transform: `translate(${innerWidth / 2 - cx}px, ${innerHeight / 2 - cy}px) scale(${scale})`,
  };
}

export type CrtScreen = {
  canvas: HTMLCanvasElement;
  /** Before a zoom: draws at the window's size from now on (not the element's), with the code fully typed. */
  lock(): void;
  /** Settles the CRT look to a pass-through over `ms`. */
  settle(ms: number): Promise<void>;
  stop(): void;
};

/**
 * Starts the CRT in `screen`, an element holding a canvas; sets `--crt-aspect` on it to the window's aspect, so a
 * zoom into it fills the window exactly. Null without WebGL.
 */
export function startCrt(screen: HTMLElement): CrtScreen | null {
  const canvas = screen.querySelector("canvas")!;
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
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
  // The drawing is laid out like the playground in this window, so a zoom ends on roughly the real layout.
  let win = { w: innerWidth, h: innerHeight };
  const sceneScale = () => Math.min(1, 960 / win.w) * Math.min(devicePixelRatio, 2);
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
  let locked = false;
  let stopped = false;
  let frame = 0;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  });
  observer.observe(screen);
  const schedule = () => {
    if (!frame && !stopped && (visible || locked) && !document.hidden) frame = requestAnimationFrame(render);
  };

  function render(now: number) {
    frame = 0;
    const time = (now - start) / 1000;
    const k = sceneScale();
    const sw = Math.round(win.w * k);
    const sh = Math.round(win.h * k);
    if (scene.width !== sw || scene.height !== sh) Object.assign(scene, { width: sw, height: sh });
    // Types the code, holds it for a few seconds, then starts again.
    const typed = locked ? TOTAL : Math.min(TOTAL, Math.floor(Math.max(0, (time % 14) - 0.8) * 28));
    drawPlayground(g, win.w, win.h, k, typed, time);
    if (!locked) {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio, 2);
      const cw = Math.max(1, Math.round(box.width * dpr));
      const ch = Math.max(1, Math.round(box.height * dpr));
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
    schedule();
  }
  document.addEventListener("visibilitychange", schedule);
  schedule();

  return {
    canvas,
    lock() {
      locked = true;
      const dpr = Math.min(devicePixelRatio, 2);
      Object.assign(canvas, { width: Math.round(win.w * dpr), height: Math.round(win.h * dpr) });
      schedule();
    },
    async settle(ms) {
      const t0 = performance.now();
      for (let t = 0; t < 1; ) {
        t = Math.min(1, ((await nextFrame()) - t0) / ms);
        const e = ease(t);
        params = Object.fromEntries(Object.entries(CRT).map(([key, from]) => [key, from + (BASELINE[key as keyof Params] - from) * e])) as Params;
      }
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      removeEventListener("resize", fit);
      document.removeEventListener("visibilitychange", schedule);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
