/** The last folder opened from disk. Directory handles survive in IndexedDB (not in localStorage), permission aside. */
type Handle = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
};

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("bwc-folders", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function request<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = op(d.transaction("handles", mode).objectStore("handles"));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}

export function rememberFolder(dir: FileSystemDirectoryHandle): Promise<void> {
  return request("readwrite", (s) => s.put(dir, "last")).then(
    () => {},
    () => {},
  );
}

export function lastFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  return request<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get("last")).catch(() => undefined);
}

/** Whether the page may write to `dir`; with `ask`, prompts (needs a click or key press just before). */
export async function canWrite(dir: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const h = dir as Handle;
  try {
    if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return ask && (await h.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}
