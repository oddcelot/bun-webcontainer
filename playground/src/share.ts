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

/** The current project as a link to this page. Binary files can't travel in it and are skipped. */
export async function shareLink(vfs: VFS): Promise<{ url: string; files: number; skipped: number }> {
  const files: Record<string, string> = {};
  let skipped = 0;
  for (const [path, data] of vfs.files) {
    if (SKIP.test(path)) continue;
    if (typeof data === "string") files[path] = data;
    else skipped++;
  }
  const payload: Payload = { v: 1, files };
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream("deflate-raw"));
  const url = new URL(location.href);
  url.search = "";
  url.hash = PREFIX.slice(1) + toBase64Url(packed);
  return { url: url.href, files: Object.keys(files).length, skipped };
}

/** Fills the VFS from a share link's hash; returns the number of files. Throws on a damaged link. */
export async function loadShareLink(vfs: VFS, hash: string): Promise<number> {
  const json = new TextDecoder().decode(await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream("deflate-raw")));
  const { v, files } = JSON.parse(json) as Payload;
  if (v !== 1 || typeof files !== "object") throw new Error("unknown share link format");
  for (const [path, text] of Object.entries(files)) vfs.write(path, text);
  return Object.keys(files).length;
}
