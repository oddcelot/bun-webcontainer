import { createSignal } from "solid-js";
import { makePersisted, type PersistenceSyncAPI } from "@solid-primitives/storage";

/**
 * Like the package's `storageSync`, but for every tab: that one drops changes from tabs at another URL, and each
 * project has its own (`?example=`, `?repo=`).
 */
const everyTab: PersistenceSyncAPI = [
  (subscriber) => {
    const onStorage = (e: StorageEvent) => e.storageArea === localStorage && e.key && subscriber({ key: e.key, newValue: e.newValue, timeStamp: e.timeStamp });
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  },
  () => {},
];

/**
 * A setting kept in localStorage under `name` and shared live by every tab. A stored value that `deserialize` throws
 * on (or that isn't JSON, by default) leaves `initial`.
 */
export function pref<T>(name: string, initial: Exclude<T, Function>, options?: { serialize?: (value: T) => string; deserialize?: (data: string) => T }) {
  // makePersisted restores the stored value with a write right away, which Solid 2 only allows inside a component or
  // root when opted in.
  const [get, set] = makePersisted(createSignal<T>(initial, { ownedWrite: true }), { name, sync: everyTab, ...options });
  return [get, (value: T) => void set(() => value)] as const;
}
