import { norm } from "@runbun/vfs";

// What the running program watches itself, so Watch leaves a save of such a file to it (boot.ts).

/** A folder or file the running program watches with `fs.watch` or `fs.watchFile` (worker/node/fs.ts reports them). */
export type Watched = { key: string; recursive: boolean };

/**
 * True when the program watches every changed file itself: the file, its folder, or a folder above it recursively.
 * A dev server with hot replacement or its own live reload (Vite, a `fs.watch` that rebuilds and tells the page)
 * then decides what the page does, so Watch doesn't reload the preview over it.
 */
export function watchedBy(watched: readonly Watched[], changed: Iterable<string>): boolean {
  const paths = [...changed].map(norm);
  if (!paths.length) return false;
  return paths.every((p) =>
    watched.some(({ key, recursive }) => {
      if (p === key) return true;
      if (key && !p.startsWith(`${key}/`)) return false;
      return recursive || !p.slice(key ? key.length + 1 : 0).includes("/");
    }),
  );
}
