import { strToU8, unzipSync, zipSync } from "fflate";
import { SKIP } from "./persist";
import type { VFS } from "@runbun/vfs";

/** The project as a zip, without what `bun install` or the source brings back (node_modules, .git). */
export function exportZip(vfs: VFS): Blob {
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of vfs.files) if (!SKIP.test(path)) files[path] = typeof data === "string" ? strToU8(data) : vfs.readBytes(path)!;
  return new Blob([zipSync(files, { level: 6 })], { type: "application/zip" });
}

/** A file name for the download: the package name, else "project". */
export function zipName(vfs: VFS): string {
  let name = "";
  try {
    name = JSON.parse(vfs.readText("package.json") ?? "{}").name ?? "";
  } catch {}
  return (name.replace(/^@/, "").replace(/[^\w.-]+/g, "-") || "project") + ".zip";
}

/**
 * A zip's files as text where they decode as UTF-8, else bytes. One folder holding everything (GitHub's zips,
 * a zipped folder) is dropped from the paths; node_modules and .git are skipped.
 */
export function importZip(bytes: Uint8Array): [string, string | Uint8Array][] {
  const entries = Object.entries(unzipSync(bytes)).filter(([p]) => !p.endsWith("/") && !p.startsWith("__MACOSX/"));
  const top = entries[0]?.[0].split("/")[0] + "/";
  const strip = entries.length > 0 && entries.every(([p]) => p.startsWith(top) && p.length > top.length);
  const dec = new TextDecoder("utf-8", { fatal: true });
  const out: [string, string | Uint8Array][] = [];
  for (const [p, data] of entries) {
    const path = strip ? p.slice(top.length) : p;
    if (SKIP.test(path)) continue;
    let d: string | Uint8Array = data;
    try {
      d = dec.decode(data);
    } catch {}
    out.push([path, d]);
  }
  return out;
}
