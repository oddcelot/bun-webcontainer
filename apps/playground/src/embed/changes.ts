import type { VFS } from "@runbun/vfs";
import type { ChangeBy } from "@runbun/embed/protocol";

/**
 * Calls `emit` for each file change the host hears about (`ignore` drops the rest), with who made it: an install while
 * `installWriting`, the program while `programWriting`, the host inside the returned `asHost`, else the reader. A write
 * that left the file as it was isn't a change. Returns `asHost`.
 */
export function watchChanges(
  vfs: VFS,
  programWriting: () => boolean,
  installWriting: () => boolean,
  ignore: (path: string) => boolean,
  emit: (data: { path: string; removed: boolean; by: ChangeBy }) => void,
) {
  let host = false;
  vfs.onChange(({ path, removed, unchanged }) => {
    if (unchanged || ignore(path)) return;
    emit({ path, removed: !!removed, by: host ? "host" : installWriting() ? "install" : programWriting() ? "program" : "reader" });
  });
  return <T>(fn: () => T): T => {
    host = true;
    try {
      return fn();
    } finally {
      host = false;
    }
  };
}
