import { AsyncLocalStorage } from "node:async_hooks";

export const store = new AsyncLocalStorage<string>();

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

/** Awaits through several frames, a thenable, a rejection and a generator before reading the store. */
export async function chain(log: (label: string) => void) {
  await tick();
  log("lib-tick");
  await { then: (r: () => void) => setTimeout(r, 1) };
  log("lib-thenable");
  const step = async (n: number): Promise<number> => (n ? 1 + (await step(n - 1)) : (await tick(), 0));
  await step(3);
  log("lib-recursive");
  try {
    await Promise.reject(new Error("x"));
  } catch {
    log("lib-catch");
  }
  async function* gen() {
    await tick();
    yield 1;
    await tick();
    yield 2;
  }
  for await (const _ of gen()) {
    log("lib-for-await");
    await tick();
  }
  log("lib-loop-done");
  for await (const _ of gen()) break;
  log("lib-after-break");
}
