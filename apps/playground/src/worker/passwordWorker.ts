// The async `Bun.password` forms' thread (see password.ts): its own resolve-wasm instance, from the module the runtime
// worker compiled, over an empty VFS. argon2 grows that instance's memory (64 MiB with the defaults); terminating the
// worker gives it back.
import { VFS } from "@runbun/vfs";
import { passwordHash, passwordVerify, PasswordError, startResolver, type PasswordAlgorithm } from "../resolver";

export type PasswordJob =
  | { id: number; op: "hash"; password: Uint8Array; salt: Uint8Array; algorithm: PasswordAlgorithm; memoryCost: number; timeCost: number }
  | { id: number; op: "verify"; password: Uint8Array; hash: Uint8Array; algorithm: PasswordAlgorithm };
/** `password` is a PasswordError's name (Bun's error), `message` anything else (a panic). */
export type PasswordResult = { id: number; value: string | boolean } | { id: number; password: string } | { id: number; message: string };

const scope = self as unknown as Worker;

scope.onmessage = (e: MessageEvent<{ module: WebAssembly.Module } | PasswordJob>) => {
  const m = e.data;
  if ("module" in m) return startResolver(m.module, new VFS());
  let result: PasswordResult;
  try {
    const value = m.op === "hash" ? passwordHash(m.password, m.salt, m.algorithm, m.memoryCost, m.timeCost) : passwordVerify(m.password, m.hash, m.algorithm);
    result = { id: m.id, value };
  } catch (err) {
    result = err instanceof PasswordError ? { id: m.id, password: err.message } : { id: m.id, message: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
  scope.postMessage(result);
};
