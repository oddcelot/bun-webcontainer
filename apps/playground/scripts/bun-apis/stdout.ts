// Bun.stdout.writer() and Bun.stderr.writer(): FileSinks onto the console (stderr goes to the same pane here, so the
// harness reads stdout only).
export async function stdout(log: (line: string) => void) {
  const w = Bun.stdout.writer();
  log(`writer: ${typeof w.write} ${typeof w.flush} ${typeof w.end} ${typeof w.ref} ${typeof w.unref} ${w.constructor.name}`);
  log(`same writer: ${Bun.stdout.writer() === w}`);
  log(`write returns: ${w.write("sink: a")}`);
  log(`write bytes returns: ${w.write(new TextEncoder().encode("b"))}`);
  log(`write buffer returns: ${w.write(new Uint8Array([99]).buffer)}`);
  w.write("\n");
  log(`flush returns: ${w.flush()}`);
  w.write("sink: again\n");
  log(`flush again: ${w.flush()}`);
  log(`flush empty: ${w.flush()}`);
  w.write("sink: unflushed\n");
  await Promise.resolve();
  log("after a microtask");
  await new Promise((r) => setTimeout(r, 0));
  log("after a timer");
  w.write("sink: flushed before the timer\n");
  queueMicrotask(() => log("microtask"));
  setTimeout(() => log("timer"), 0);
  await Bun.sleep(5);
  log("after sleep");
  w.write("sink: before end\n");
  log(`ref/unref: ${w.ref()} ${w.unref()}`);
  const ended = w.end();
  log(`end returns: ${ended instanceof Promise ? "promise " + (await ended) : ended}`);
  try {
    log(`write after end: ${w.write("x")}`);
  } catch (e) {
    log(`write after end: threw ${(e as Error).name} ${(e as Error).message}`);
  }
  const e = Bun.stderr.writer();
  log(`stderr writer: ${e === (w as unknown)} ${e.write("")} ${e.flush()}`);
  const w2 = Bun.stdout.writer({ highWaterMark: 4 });
  log(`highWaterMark writer same: ${w2 === w}`);
  log(`w2 write: ${w2.write("sink: high\n")}`);
  await w2.flush();
  log("done");
}
