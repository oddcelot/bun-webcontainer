import { Buffer } from "./node/buffer";
import { codeError } from "./node/errors";

const MAX_TIMESTAMP = 2 ** 48 - 1;

// RFC 9562 §6.2 monotonic state, as Bun keeps it (bun_jsc uuid.rs): one for the clock, one for timestamps a caller
// passes, so an explicit call neither sees nor moves the clock's.
let clockLast = 0;
let clockCount = 0;
let explicitRequested = -1;
let explicitEmitted = 0;
let explicitCount = 0;

/** The (possibly bumped) timestamp and the 12-bit counter: the counter goes up within a millisecond. */
function next(timestamp: number, seed: number, explicit: boolean): [number, number] {
  // The counter's high bit is a rollover guard: a fresh millisecond has at least 2048 increments left.
  seed &= 0x07ff;
  let ts: number;
  let count: number;
  if (explicit) [ts, count] = timestamp !== explicitRequested ? [timestamp, seed] : [explicitEmitted, explicitCount + 1];
  else [ts, count] = timestamp > clockLast ? [timestamp, seed] : [clockLast, clockCount + 1];
  if (count > 0x0fff) {
    ts = Math.min(ts + 1, MAX_TIMESTAMP);
    count = seed;
  }
  if (explicit) [explicitRequested, explicitEmitted, explicitCount] = [timestamp, ts, count];
  else [clockLast, clockCount] = [ts, count];
  return [ts, count];
}

const typeName = (v: unknown) => (v === null ? "object" : typeof v);

/** A timestamp argument: a number or Date, a whole number of milliseconds within UUIDv7's 48 bits. */
function timestampOf(v: unknown): number {
  if (typeof v !== "number" && !(v instanceof Date)) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "timestamp" property must be of type number. Received ${typeName(v)}`);
  const t = typeof v === "number" ? v : v.getTime();
  if (!(t >= 0 && t <= MAX_TIMESTAMP)) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "timestamp" is out of range. It must be >= 0 and <= ${MAX_TIMESTAMP}. Received ${t}`);
  if (Math.floor(t) !== t) throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "timestamp" property must be of type integer. Received number`);
  return t;
}

const ENCODINGS = ["hex", "base64", "base64url", "buffer"];

/**
 * `Bun.randomUUIDv7(encoding?, timestamp?)`: a time-ordered UUID (RFC 9562), as Bun makes it: 48 bits of
 * milliseconds, a 12-bit counter seeded at random that goes up within the same millisecond, then 62 random bits.
 * A first argument that isn't a string is the timestamp, unless a second one is passed.
 */
export function randomUUIDv7(encoding?: unknown, timestamp?: unknown): string | Buffer {
  let enc = "hex";
  let time: number | undefined;
  if (typeof encoding === "string") {
    enc = encoding.toLowerCase();
    if (!ENCODINGS.includes(enc)) throw codeError(TypeError, "ERR_UNKNOWN_ENCODING", "Encoding must be one of base64, base64url, hex, or buffer");
  }
  if (arguments.length >= 2) {
    if (timestamp !== undefined) time = timestampOf(timestamp);
  } else if (encoding !== undefined && typeof encoding !== "string") time = timestampOf(encoding);

  const random = crypto.getRandomValues(new Uint8Array(10));
  const [ts, count] = next(time ?? Date.now(), random[8] | (random[9] << 8), time !== undefined);
  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp (beyond 32-bit bitwise ops: split it).
  const hi = Math.floor(ts / 2 ** 32);
  const lo = ts >>> 0;
  bytes.set([(hi >>> 8) & 0xff, hi & 0xff, lo >>> 24, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff]);
  bytes[6] = 0x70 | ((count >> 8) & 0x0f);
  bytes[7] = count & 0xff;
  bytes[8] = 0x80 | (random[0] & 0x3f);
  bytes.set(random.subarray(1, 8), 9);

  const buf = Buffer.from(bytes.buffer);
  if (enc === "buffer") return buf;
  if (enc !== "hex") return buf.toString(enc as "base64" | "base64url");
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
