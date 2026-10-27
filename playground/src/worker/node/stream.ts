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
Object.defineProperty(Stream, "promises", { enumerable: true, configurable: true, get: () => streamPromises });

export const Readable: typeof rsTyped.Readable = rs.Readable;
export const Writable: typeof rsTyped.Writable = rs.Writable;
export const Duplex: typeof rsTyped.Duplex = rs.Duplex;
export const promises = { pipeline: streamPromises.pipeline, finished: streamPromises.finished };
export default Stream;
