import { Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { ALERT_CSS, githubMarkdown } from "../githubMarkdown";
import { onTheme } from "../theme";
import { AppContext } from "./context";
import { guarded } from "./guarded";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};
const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
export const isImage = (path: string) => /\.[^./]+$/.test(path) && ext(path) in MIME;
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
/** Files the editor can show rendered: images, and Markdown. */
export const previewable = (path: string) => isImage(path) || isMarkdown(path);
/** Images but SVG are bytes: they only preview. SVG and Markdown also open as code. */
export const onlyPreview = (path: string) => isImage(path) && ext(path) !== "svg";

/** A project path from `from`'s folder and a relative reference (`./img.png`, `../a/b.svg`), or null for a URL. */
function resolve(from: string, ref: string): string | null {
  if (/^([a-z][\w+.-]*:|\/\/|#)/i.test(ref)) return null;
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  const parts = clean.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const p of clean.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1 << 20 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** The app's colors and fonts, for the Markdown frame (it can't see the page's styles). */
function frameStyle() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return `:root { color-scheme: ${css.colorScheme || "light dark"}; }
body { margin: 0; padding: 16px 24px 48px; background: ${v("--bg")}; color: ${v("--fg")}; font: 14px/1.6 ${css.fontFamily}; overflow-wrap: break-word; }
body > :first-child { margin-top: 0; }
a[href] { color: ${v("--accent")}; }
h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid ${v("--control-border")}; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
code { padding: 0.15em 0.35em; border-radius: 4px; background: ${v("--panel")}; }
pre { padding: 12px 16px; overflow: auto; border-radius: 6px; background: ${v("--panel")}; }
pre code { padding: 0; background: none; }
blockquote { margin: 0; padding: 0 1em; border-left: 3px solid ${v("--control-border")}; color: ${v("--muted")}; }
table { border-collapse: collapse; }
th, td { padding: 4px 10px; border: 1px solid ${v("--control-border")}; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid ${v("--control-border")}; }
li:has(> input[type="checkbox"]) { list-style: none; }`;
}

/**
 * The open image or Markdown file, rendered in the editor's place. Markdown goes to a sandboxed frame without
 * scripts (a shared project's README may hold HTML), its project images inlined; links to the web open in a new tab.
 */
export function FilePreview(props: { path: string; shown: boolean }) {
  const { vfs, log } = useContext(AppContext);
  let frame!: HTMLIFrameElement;
  const [image, setImage] = createSignal<{ url: string; bytes: number; w?: number; h?: number } | null>(null);
  const [version, setVersion] = createSignal(0);

  async function bytesOf(path: string) {
    await vfs.ensure([path]);
    return vfs.readBytes(path);
  }

  async function dataUrl(path: string) {
    const bytes = await bytesOf(path);
    if (!bytes) return null;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${MIME[ext(path)] ?? "application/octet-stream"};base64,${btoa(bin)}`;
  }

  async function renderMarkdown(path: string) {
    await vfs.ensure([path]);
    const text = vfs.readText(path) ?? "";
    const doc = await githubMarkdown(text);
    for (const img of doc.querySelectorAll("img[src]")) {
      const at = resolve(path, img.getAttribute("src")!);
      if (at === null) continue;
      const url = vfs.files.has(at) && isImage(at) ? await dataUrl(at) : null;
      if (url) img.setAttribute("src", url);
    }
    // Links to the web open in a new tab; a heading's (#…) scrolls the frame. Links between the project's files can't
    // be followed from the frame: they stay as text.
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href")!;
      if (href.startsWith("#")) continue;
      if (resolve(path, href) === null) a.setAttribute("target", "_blank");
      else a.removeAttribute("href");
    }
    const csp = "default-src 'none'; img-src data: https: http:; media-src data: https:; style-src 'unsafe-inline'";
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${frameStyle()}\n${ALERT_CSS}</style>${doc.body.innerHTML}`;
  }

  let token = 0;
  // The path as last applied: the VFS and theme callbacks read this, not the props.
  let shownPath = "";
  createEffect(
    () => [props.path, props.shown, version()] as const,
    guarded("file preview", ([path, shown]) => {
      shownPath = shown ? path : "";
      if (!shown) return;
      const mine = ++token;
      if (isMarkdown(path)) {
        setImage(null);
        void renderMarkdown(path)
          .then((html) => mine === token && (frame.srcdoc = html))
          .catch((e) => log("warn", `[preview] couldn't render ${path}: ${e}`));
        return;
      }
      let url: string | undefined;
      void bytesOf(path).then((bytes) => {
        if (mine !== token || !bytes) return;
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[ext(path)] }));
        setImage({ url, bytes: bytes.length });
      });
      return () => url && URL.revokeObjectURL(url);
    }),
  );

  onSettled(() => {
    // The file (or, for Markdown, an image it may show) changed; and the frame follows the theme.
    const unsubscribe = vfs.onChange(({ path }) => {
      if (shownPath && (path === shownPath || (isMarkdown(shownPath) && isImage(path)))) setVersion((n) => n + 1);
    });
    const untheme = onTheme(() => {
      if (isMarkdown(shownPath)) setVersion((n) => n + 1);
    });
    return () => {
      unsubscribe();
      untheme();
    };
  });

  return (
    <div class="file-preview" hidden={!props.shown}>
      <iframe ref={frame} title={`Preview of ${props.path}`} sandbox="allow-popups allow-popups-to-escape-sandbox" hidden={!isMarkdown(props.path)} />
      <Show when={image()}>
        {(img) => (
        <figure class="image">
          <img
            src={img().url}
            alt={props.path}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              setImage((i) => i && { ...i, w, h });
            }}
          />
          <figcaption>
            {img().w ? `${img().w} × ${img().h} · ` : ""}
            {size(img().bytes)}
          </figcaption>
        </figure>
        )}
      </Show>
    </div>
  );
}
