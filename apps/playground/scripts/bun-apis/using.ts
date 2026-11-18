// `using` and `await using` (explicit resource management): the transpiler lowers them onto bun:wrap's __using and
// __callDispose, so disposal order, async disposal and SuppressedError come out as in Bun.
export async function using(log: (line: string) => void) {
  const disposable = (name: string, fail = false) => ({
    [Symbol.dispose]() {
      log(`using: dispose ${name}`);
      if (fail) throw new Error(`dispose ${name} failed`);
    },
  });
  {
    using a = disposable("a");
    using b = disposable("b");
    log(`using: in block ${typeof a} ${typeof b}`);
  }
  await (async () => {
    await using c = {
      async [Symbol.asyncDispose]() {
        log("using: async dispose c");
      },
    };
    log(`using: in async block ${typeof c}`);
  })();
  try {
    using d = disposable("d", true);
    log(`using: before throw ${typeof d}`);
    throw new Error("body failed");
  } catch (e) {
    const s = e as { name: string; error?: Error; suppressed?: Error };
    log(`using: caught ${s.name} ${s.error?.message} / ${s.suppressed?.message}`);
  }
  try {
    using e = 42 as unknown as Disposable;
    log(`using: ${e}`);
  } catch (e) {
    log(`using: not disposable ${(e as Error).name}`);
  }
}
