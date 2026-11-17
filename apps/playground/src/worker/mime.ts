// File extension to the Content-Type Bun gives it (Bun.file, Bun.build artifacts, S3 uploads): a subset of Bun's table.
const JS = "text/javascript;charset=utf-8";
export const MIME: Record<string, string> = {
  js: JS,
  mjs: JS,
  cjs: JS,
  ts: JS,
  mts: JS,
  cts: JS,
  jsx: JS,
  tsx: JS,
  css: "text/css;charset=utf-8",
  html: "text/html;charset=utf-8",
  json: "application/json;charset=utf-8",
  map: "application/json;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  xml: "application/xml;charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
};
export const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf(".") + 1)] ?? "";
/** A type name as Bun writes it (`application/json` is `application/json;charset=utf-8`); an unknown one is kept. */
export const mimeByName = (type: string) => Object.values(MIME).find((v) => v === type || v.startsWith(type + ";")) ?? type;
