import { BASE } from "./base";
import type { VFS } from "./vfs";

// A project as a link: its text files (no node_modules) as JSON, deflated, base64url, in the URL's #hash.
// The hash never reaches the server, so nothing is uploaded or stored; opening the link installs as usual.

const PREFIX = "#code=";
const SKIP = /(^|\/)(node_modules|\.git)\//;
type Payload = { v: 1; files: Record<string, string> };

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

const toBase64Url = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const isShareLink = (hash: string) => hash.startsWith(PREFIX);

/** Where the project came from: the query that loads it again (`?repo=…`, `?example=…`, "" for the demo). */
type Source = { query: string; label: string; files: Map<string, string> };
let source: Source | undefined;
const projectFiles = (vfs: VFS) => [...vfs.files].filter(([path]) => !SKIP.test(path));

/**
 * Call right after a project loads from a repo, an example or the demo. While its files stay as they were, Share
 * gives the short link that loads them again instead of packing them into the URL.
 */
export function rememberSource(vfs: VFS, query: string, label: string) {
  source = { query, label, files: new Map(projectFiles(vfs).map(([p, d]) => [p, typeof d === "string" ? d : `\0${d.length}`])) };
}

const unchanged = (vfs: VFS, s: Source) => {
  const now = projectFiles(vfs);
  return now.length === s.files.size && now.every(([p, d]) => s.files.get(p) === (typeof d === "string" ? d : `\0${d.length}`));
};

/** Files that usually hold secrets: never packed into a link (templates like .env.example are fine). */
const SECRET = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|\.netrc|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa))$/;
/** Over this, some chat apps cut a link off; Share tries without bun.lock, then suggests GitHub. */
export const LONG_LINK = 32 * 1024;

type Link = {
  url: string;
  files: number;
  /** Binary files, which can't travel in a link. */
  skipped: number;
  /** Secret files that were left out, by path. */
  secrets: string[];
  /** bun.lock was left out to keep the link short; versions are resolved from package.json again. */
  droppedLock: boolean;
  /** Set for a short link: what it points to. */
  short?: string;
};

async function pack(files: Record<string, string>): Promise<string> {
  const payload: Payload = { v: 1, files };
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream("deflate-raw"));
  const url = new URL(location.href);
  url.search = "";
  url.hash = PREFIX.slice(1) + toBase64Url(packed);
  return url.href;
}

/**
 * The current project as a link to this page: the short link to where it came from while it's unchanged, else
 * its text files packed into the hash. Binary and secret files are left out; when the link would be long and
 * there's a bun.lock, it's left out too (the install resolves versions from package.json then).
 */
export async function shareLink(vfs: VFS): Promise<Link> {
  if (source && unchanged(vfs, source)) {
    const url = new URL(BASE + source.query, location.origin);
    return { url: url.href, files: source.files.size, skipped: 0, secrets: [], droppedLock: false, short: source.label };
  }
  const files: Record<string, string> = {};
  const secrets: string[] = [];
  let skipped = 0;
  for (const [path, data] of vfs.files) {
    if (SKIP.test(path)) continue;
    if (SECRET.test(path)) secrets.push(path);
    else if (typeof data === "string") files[path] = data;
    else skipped++;
  }
  let url = await pack(files);
  let droppedLock = false;
  if (url.length > LONG_LINK && "bun.lock" in files && "package.json" in files) {
    const { "bun.lock": _, ...rest } = files;
    url = await pack(rest);
    droppedLock = true;
  }
  return { url, files: Object.keys(files).length - (droppedLock ? 1 : 0), skipped, secrets, droppedLock };
}

/** Fills the VFS from a share link's hash; returns the number of files. Throws on a damaged link. */
export async function loadShareLink(vfs: VFS, hash: string): Promise<number> {
  const json = new TextDecoder().decode(await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream("deflate-raw")));
  const { v, files } = JSON.parse(json) as Payload;
  if (v !== 1 || typeof files !== "object") throw new Error("unknown share link format");
  for (const [path, text] of Object.entries(files)) vfs.write(path, text);
  return Object.keys(files).length;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The Share menu (a popover under the Share button): copy the link, a Markdown badge for a README, or the same
 * badge as HTML. The link is built when the menu opens, so it carries the files as they are then.
 */
export function mountShareMenu(menu: HTMLElement, vfs: VFS, log: (level: string, text: string) => void) {
  const badge = new URL(`${BASE}badge.svg`, location.origin).href;
  let link: Awaited<ReturnType<typeof shareLink>> | undefined;
  const size = menu.querySelector<HTMLElement>("[data-share-size]")!;
  const lead = menu.querySelector<HTMLElement>("[data-share-lead]")!;
  const notes = menu.querySelector<HTMLElement>("[data-share-notes]")!;
  const leadText = lead.textContent!;
  /** What the link leaves out, and whether it's long: one line each. */
  const noteLines = (l: Link) => [
    l.secrets.length ? `Left out, as they may hold secrets: ${l.secrets.join(", ")}` : "",
    l.skipped ? `Left out: ${l.skipped} binary ${l.skipped === 1 ? "file" : "files"} (images, fonts, …)` : "",
    l.droppedLock ? "Left out bun.lock to keep the link short: versions are resolved from package.json." : "",
    l.url.length > LONG_LINK
      ? "Long link: some chat apps cut these off. For a project this size, push it to GitHub and share it from there (?repo=)."
      : "",
  ].filter(Boolean);
  const formats: Record<string, (url: string) => string> = {
    link: (url) => url,
    markdown: (url) => `[![Open in runbun](${badge})](${url})`,
    html: (url) => `<a href="${escapeAttr(url)}"><img src="${badge}" alt="Open in runbun" width="150" height="28"></a>`,
  };

  menu.addEventListener("beforetoggle", async (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    size.textContent = "…";
    link = await shareLink(vfs);
    if (link.short) {
      lead.textContent = `A short link to ${link.short}. Edit a file and the link carries your copy instead.`;
      size.textContent = link.url.replace(/^https?:\/\//, "");
    } else {
      lead.textContent = leadText;
      size.textContent = `${link.files} files · ${(link.url.length / 1024).toFixed(1)} KB`;
    }
    const lines = noteLines(link);
    notes.replaceChildren(...lines.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    notes.hidden = !lines.length;
    notes.classList.toggle("warn", link.url.length > LONG_LINK);
  });

  for (const item of menu.querySelectorAll<HTMLButtonElement>("[data-share]")) {
    const label = item.querySelector<HTMLElement>(".title")!;
    const idle = label.textContent!;
    item.onclick = async () => {
      link ??= await shareLink(vfs);
      const kind = item.dataset.share!;
      const text = formats[kind](link.url);
      // The address bar shows the link too, so it can be copied from there or bookmarked.
      history.replaceState(null, "", link.url);
      let copied = true;
      await navigator.clipboard.writeText(text).catch(() => (copied = false));
      const what = kind === "link" ? "link" : kind === "markdown" ? "Markdown badge" : "HTML badge";
      log("sys", `[share] ${copied ? `${what} copied` : "copying failed; the link is in the address bar"}: ${size.textContent}`);
      for (const line of noteLines(link)) log(link.url.length > LONG_LINK && line.startsWith("Long") ? "warn" : "sys", `[share] ${line}`);
      item.dataset.copied = "";
      label.textContent = copied ? "Copied" : "Couldn't copy";
      setTimeout(() => {
        delete item.dataset.copied;
        label.textContent = idle;
      }, 1400);
    };
  }
}
