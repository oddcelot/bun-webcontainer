import rsTyped from "readable-stream";

const rs: any = rsTyped;
const Stream = rs.Stream;
const streamPromises = rs.promises;

Object.assign(Stream, {
  Stream,
  Readable: rs.Readable,
  Writable: rs.Writable,
  Duplex: rs.Duplex,
  Transform: rs.Transform,
  PassThrough: rs.PassThrough,
  pipeline: rs.pipeline,
  finished: rs.finished,
  addAbortSignal: rs.addAbortSignal,
  compose: rs.compose,
  isReadable: rs.isReadable,
  isErrored: rs.isErrored,
  isDisturbed: rs.isDisturbed,
});
// readable-stream leaves the web-stream bridges unimplemented (devframe's static files use `Readable.toWeb`).
rs.Readable.toWeb = (r: any) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      r.on("data", (chunk: string | Uint8Array) => {
        c.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        if ((c.desiredSize ?? 1) <= 0) r.pause();
      });
      r.on("end", () => c.close());
      r.on("error", (e: unknown) => c.error(e));
    },
    pull() {
      r.resume();
    },
    cancel(reason) {
      r.destroy(reason);
    },
  });
rs.Readable.fromWeb = (stream: ReadableStream, options?: object) =>
  rs.Readable.from(
    (async function* () {
      const reader = stream.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) yield r.value;
    })(),
    options,
  );
Object.defineProperty(Stream, "promises", { enumerable: true, configurable: true, get: () => streamPromises });

export const Readable: typeof rsTyped.Readable = rs.Readable;
export const Writable: typeof rsTyped.Writable = rs.Writable;
export const Duplex: typeof rsTyped.Duplex = rs.Duplex;
export const promises = { pipeline: streamPromises.pipeline, finished: streamPromises.finished };
export default Stream;
