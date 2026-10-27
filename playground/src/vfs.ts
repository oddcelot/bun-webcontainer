export type FileData = string | Uint8Array;
export type VfsEvent = { path: string; created: boolean };

export function norm(p: string): string {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

export const dirname = (p: string) => p.split("/").slice(0, -1).join("/");

const dec = new TextDecoder();
const enc = new TextEncoder();

export class VFS {
  readonly files = new Map<string, FileData>();
  readonly dirs = new Set<string>();
  private listeners = new Set<(e: VfsEvent) => void>();

  onChange(fn: (e: VfsEvent) => void) {
    this.listeners.add(fn);
  }

  read(path: string): FileData | undefined {
    return this.files.get(norm(path));
  }

  readText(path: string): string | undefined {
    const d = this.read(path);
    return d === undefined ? undefined : typeof d === "string" ? d : dec.decode(d);
  }

  readBytes(path: string): Uint8Array | undefined {
    const d = this.read(path);
    return d === undefined ? undefined : typeof d === "string" ? enc.encode(d) : d;
  }

  write(path: string, data: FileData) {
    const p = norm(path);
    const created = !this.files.has(p);
    this.files.set(p, data);
    if (created) this.mkdir(dirname(p));
    for (const fn of this.listeners) fn({ path: p, created });
  }

  /** Drops every file and directory, e.g. before loading another project. */
  clear() {
    this.files.clear();
    this.dirs.clear();
  }

  mkdir(path: string) {
    const parts = norm(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }

  exists(path: string): boolean {
    const p = norm(path);
    if (p === "" || this.files.has(p) || this.dirs.has(p)) return true;
    for (const k of this.files.keys()) if (k.startsWith(p + "/")) return true;
    return false;
  }

  list(prefix = ""): string[] {
    const p = norm(prefix);
    const pre = p ? p + "/" : "";
    return [...this.files.keys()].filter((k) => k.startsWith(pre)).sort();
  }
}
