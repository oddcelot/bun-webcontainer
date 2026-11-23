import { SKIP } from "./persist";

const dec = new TextDecoder("utf-8", { fatal: true });

/** A file's contents as text where they decode as UTF-8, else bytes (as a folder opens). */
async function contents(file: File): Promise<string | Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return dec.decode(bytes);
  } catch {
    return bytes;
  }
}

/** Everything in a dropped entry, folders read through, with paths from the drop (`src/a.ts` for a dropped `src`). */
async function read(entry: FileSystemEntry, out: [string, File][]) {
  const path = entry.fullPath.replace(/^\//, "");
  if (SKIP.test(path)) return;
  if (entry.isFile) {
    out.push([path, await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail))]);
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries hands a folder over in batches (100 in Chrome) until an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    for (const e of batch) await read(e, out);
  }
}

/**
 * The files dropped on the page, dropped folders with what's in them, as text or bytes; node_modules and .git are
 * skipped. Call it in the drop handler, before anything awaits: the drop's items are gone after it returns.
 */
export async function droppedFiles(data: DataTransfer): Promise<[string, string | Uint8Array][]> {
  // Synchronously, while the items are still readable.
  const entries = [...data.items].flatMap((item) => (item.kind === "file" ? [item.webkitGetAsEntry()] : [])).filter((e) => e !== null);
  const files: [string, File][] = [];
  if (entries.length) for (const e of entries) await read(e, files);
  // No entries API: the plain files (folders don't come through).
  else for (const f of data.files) files.push([f.name, f]);
  return Promise.all(files.map(async ([path, file]) => [path, await contents(file)] as [string, string | Uint8Array]));
}
