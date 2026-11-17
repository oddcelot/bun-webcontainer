// node:v8 as Bun has it (bun/src/js/node/v8.ts). `serialize`/`deserialize` write and read JavaScriptCore's
// structured-clone format (WebCore's SerializedScriptValue, version 14), as Bun does, so the bytes are Bun's: a value
// serialized here deserializes in Bun and back. Buffers travel in Bun's envelope (0xFF "BUN" 1, then `[value,
// buffers]`) so they come back as Buffers. What can differ: a number JSC keeps as a double though it is integral
// (`1.5 * 2`) is a DoubleTag there and an IntTag here, and a string JSC holds as UTF-16 though it is Latin-1. Heap
// statistics have Bun's shape with what the browser reports (`performance.memory` where Chrome has it).
import { Buffer } from "./buffer";
import { codeError } from "./errors";

// SerializationTag
const T = {
  Array: 1,
  Object: 2,
  Undefined: 3,
  Null: 4,
  Int: 5,
  Zero: 6,
  One: 7,
  False: 8,
  True: 9,
  Double: 10,
  Date: 11,
  String: 16,
  EmptyString: 17,
  RegExp: 18,
  ObjectReference: 19,
  ArrayBuffer: 21,
  ArrayBufferView: 22,
  TrueObject: 24,
  FalseObject: 25,
  StringObject: 26,
  EmptyStringObject: 27,
  NumberObject: 28,
  SetObject: 29,
  MapObject: 30,
  NonMapProperties: 31,
  NonSetProperties: 32,
  BigInt: 47,
  BigIntObject: 48,
  ErrorInstance: 55,
} as const;
const VERSION = 14;
const TERMINATOR = 0xffffffff;
const STRING_POOL = 0xfffffffe;
const NON_INDEX_PROPERTIES = 0xfffffffd;
const IS_8BIT = 0x80000000;
const ENVELOPE = [0xff, 0x42, 0x55, 0x4e, 0x01];

const VIEWS: [Function, number][] = [
  [DataView, 0],
  [Int8Array, 1],
  [Uint8Array, 2],
  [Uint8ClampedArray, 3],
  [Int16Array, 4],
  [Uint16Array, 5],
  [Int32Array, 6],
  [Uint32Array, 7],
  [Float32Array, 8],
  [Float64Array, 9],
  [BigInt64Array, 10],
  [BigUint64Array, 11],
];
const Float16 = (globalThis as { Float16Array?: Function }).Float16Array;
if (Float16) VIEWS.push([Float16, 12]);
const ERRORS = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"];
const ERROR_CTORS: ErrorConstructor[] = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError];

const cloneError = () => new DOMException("The object can not be cloned.", "DataCloneError");
const isPlain = (o: object) => {
  const tag = Object.prototype.toString.call(o);
  return tag === "[object Object]" && typeof o !== "function";
};

class Writer {
  bytes = new Uint8Array(256);
  view = new DataView(this.bytes.buffer);
  length = 0;
  strings = new Map<string, number>();
  objects = new Map<object, number>();

  #grow(n: number) {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.#grow(1);
    this.bytes[this.length++] = v;
  }
  u16(v: number) {
    this.#grow(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }
  u32(v: number) {
    this.#grow(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }
  u64(v: number | bigint) {
    this.#grow(8);
    this.view.setBigUint64(this.length, BigInt(v), true);
    this.length += 8;
  }
  f64(v: number) {
    this.#grow(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }
  raw(b: Uint8Array) {
    this.#grow(b.length);
    this.bytes.set(b, this.length);
    this.length += b.length;
  }
  /** An index into a pool of `size` entries: as small an integer as the pool needs. */
  index(i: number, size: number) {
    if (size <= 0xff) this.u8(i);
    else if (size <= 0xffff) this.u16(i);
    else this.u32(i);
  }
  /** StringData: a reference to a string written before, else its length, width and characters. */
  string(s: string) {
    const at = this.strings.get(s);
    if (at !== undefined) {
      this.u32(STRING_POOL);
      return this.index(at, this.strings.size);
    }
    this.strings.set(s, this.strings.size);
    let latin1 = true;
    for (let i = 0; i < s.length && latin1; i++) latin1 = s.charCodeAt(i) <= 0xff;
    this.u32(latin1 ? s.length | IS_8BIT : s.length);
    if (latin1) {
      this.#grow(s.length);
      for (let i = 0; i < s.length; i++) this.bytes[this.length++] = s.charCodeAt(i);
    } else {
      this.#grow(s.length * 2);
      for (let i = 0; i < s.length; i++) this.view.setUint16(this.length + i * 2, s.charCodeAt(i), true);
      this.length += s.length * 2;
    }
  }
  nullableString(s: string | undefined) {
    this.u32(s === undefined ? 1 : 0);
    if (s !== undefined) this.string(s);
  }
  bigint(v: bigint) {
    this.u8(v < 0n ? 1 : 0);
    let m = v < 0n ? -v : v;
    const words: bigint[] = [];
    while (m > 0n) words.push(m & 0xffffffffffffffffn), (m >>= 64n);
    this.u32(words.length);
    for (const w of words) this.u64(w);
  }
  /** True if `o` was written before (an ObjectReference is written); else it is recorded now. */
  seen(o: object): boolean {
    const at = this.objects.get(o);
    if (at !== undefined) {
      this.u8(T.ObjectReference);
      this.index(at, this.objects.size);
      return true;
    }
    this.objects.set(o, this.objects.size);
    return false;
  }

  value(v: unknown): void {
    switch (typeof v) {
      case "undefined":
        return this.u8(T.Undefined);
      case "boolean":
        return this.u8(v ? T.True : T.False);
      case "number":
        if (Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31 && !Object.is(v, -0)) {
          if (v === 0) return this.u8(T.Zero);
          if (v === 1) return this.u8(T.One);
          this.u8(T.Int);
          return this.u32(v);
        }
        this.u8(T.Double);
        return this.f64(v);
      case "string":
        if (!v) return this.u8(T.EmptyString);
        this.u8(T.String);
        return this.string(v);
      case "bigint":
        this.u8(T.BigInt);
        return this.bigint(v);
      case "symbol":
      case "function":
        throw cloneError();
    }
    if (v === null) return this.u8(T.Null);
    this.object(v as object);
  }

  object(o: object) {
    if (o instanceof ArrayBuffer) {
      if (this.seen(o)) return;
      this.u8(T.ArrayBuffer);
      this.u64(o.byteLength);
      return this.raw(new Uint8Array(o));
    }
    if (ArrayBuffer.isView(o)) {
      const at = this.objects.get(o);
      if (at !== undefined) return void (this.u8(T.ObjectReference), this.index(at, this.objects.size));
      const sub = VIEWS.find(([C]) => o instanceof (C as never))?.[1];
      if (sub === undefined || !(o.buffer instanceof ArrayBuffer)) throw cloneError();
      this.u8(T.ArrayBufferView);
      this.u8(sub);
      this.u64(o.byteOffset);
      this.u64(o.byteLength);
      this.object(o.buffer);
      this.objects.set(o, this.objects.size);
      return;
    }
    if (Array.isArray(o)) {
      if (this.seen(o)) return;
      this.u8(T.Array);
      this.u32(o.length);
      for (let i = 0; i < o.length; i++) {
        if (!Object.hasOwn(o, i)) continue;
        this.u32(i);
        this.value(o[i]);
      }
      const extra = Object.keys(o).filter((k) => !(String(Number(k) >>> 0) === k && Number(k) >>> 0 !== TERMINATOR));
      if (extra.length) {
        this.u32(NON_INDEX_PROPERTIES);
        this.properties(o, extra);
      } else this.u32(TERMINATOR);
      return;
    }
    if (o instanceof Map) {
      if (this.seen(o)) return;
      this.u8(T.MapObject);
      for (const [k, v] of o) this.value(k), this.value(v);
      this.u8(T.NonMapProperties);
      return this.properties(o, Object.keys(o));
    }
    if (o instanceof Set) {
      if (this.seen(o)) return;
      this.u8(T.SetObject);
      for (const k of o) this.value(k);
      this.u8(T.NonSetProperties);
      return this.properties(o, Object.keys(o));
    }
    if (o instanceof Date) {
      if (this.seen(o)) return;
      this.u8(T.Date);
      return this.f64(o.getTime());
    }
    if (o instanceof RegExp) {
      if (this.seen(o)) return;
      this.u8(T.RegExp);
      this.string(o.source);
      return this.string(o.flags);
    }
    if (o instanceof Boolean) {
      if (this.seen(o)) return;
      return this.u8(o.valueOf() ? T.TrueObject : T.FalseObject);
    }
    if (o instanceof Number) {
      if (this.seen(o)) return;
      this.u8(T.NumberObject);
      return this.f64(o.valueOf());
    }
    if (o instanceof String) {
      if (this.seen(o)) return;
      const s = o.valueOf();
      if (!s) return this.u8(T.EmptyStringObject);
      this.u8(T.StringObject);
      return this.string(s);
    }
    if (o instanceof BigInt) {
      if (this.seen(o)) return;
      this.u8(T.BigIntObject);
      return this.bigint((o as unknown as { valueOf(): bigint }).valueOf());
    }
    if (o instanceof Error) {
      if (this.seen(o)) return;
      const own = (k: string) => {
        const d = Object.getOwnPropertyDescriptor(o, k);
        return d && "value" in d ? d.value : undefined;
      };
      const name = String((o as { name?: unknown }).name).toLowerCase();
      this.u8(T.ErrorInstance);
      this.u8(Math.max(0, ERRORS.findIndex((e) => e.toLowerCase() === name)));
      const message = own("message");
      this.nullableString(message === undefined ? undefined : String(message));
      this.u32(0);
      this.u32(0);
      this.nullableString(undefined);
      return this.nullableString(typeof o.stack === "string" ? o.stack : undefined);
    }
    if (!isPlain(o) || o instanceof Promise || o instanceof WeakMap || o instanceof WeakSet) throw cloneError();
    if (this.seen(o)) return;
    this.u8(T.Object);
    this.properties(o, Object.keys(o));
  }

  /** `(<name><value>)* TerminatorTag`. */
  properties(o: object, keys: string[]) {
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d) continue;
      this.string(k);
      this.value("value" in d ? d.value : (o as Record<string, unknown>)[k]);
    }
    this.u32(TERMINATOR);
  }
}

const undeserializable = () => new TypeError("Unable to deserialize data.");

class Reader {
  at = 0;
  strings: string[] = [];
  objects: unknown[] = [];
  view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  #need(n: number) {
    if (this.at + n > this.bytes.length) throw undeserializable();
  }
  u8() {
    this.#need(1);
    return this.bytes[this.at++];
  }
  u16() {
    this.#need(2);
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32() {
    this.#need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  i32() {
    this.#need(4);
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }
  u64() {
    this.#need(8);
    const v = this.view.getBigUint64(this.at, true);
    this.at += 8;
    return v;
  }
  f64() {
    this.#need(8);
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  index(size: number) {
    return size <= 0xff ? this.u8() : size <= 0xffff ? this.u16() : this.u32();
  }
  /** StringData after its first uint32 (`head`). */
  stringFrom(head: number): string {
    if (head === STRING_POOL) {
      const i = this.index(this.strings.length);
      if (i >= this.strings.length) throw undeserializable();
      return this.strings[i];
    }
    const latin1 = (head & IS_8BIT) !== 0;
    const n = head & ~IS_8BIT;
    this.#need(latin1 ? n : n * 2);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(latin1 ? this.bytes[this.at + i] : this.view.getUint16(this.at + i * 2, true));
    this.at += latin1 ? n : n * 2;
    this.strings.push(s);
    return s;
  }
  string() {
    return this.stringFrom(this.u32());
  }
  nullableString(): string | undefined {
    const isNull = this.u32();
    if (isNull > 1) throw undeserializable();
    return isNull ? undefined : this.string();
  }
  bigint(): bigint {
    const negative = this.u8();
    const n = this.u32();
    let v = 0n;
    for (let i = 0; i < n; i++) v |= this.u64() << BigInt(64 * i);
    return negative ? -v : v;
  }
  add<V>(v: V): V {
    this.objects.push(v);
    return v;
  }
  /** `(<name><value>)* TerminatorTag` onto `o`. */
  properties(o: Record<string, unknown>) {
    for (let head = this.u32(); head !== TERMINATOR; head = this.u32()) o[this.stringFrom(head)] = this.value();
  }

  value(): unknown {
    const tag = this.u8();
    switch (tag) {
      case T.Undefined:
        return undefined;
      case T.Null:
        return null;
      case T.Int:
        return this.i32();
      case T.Zero:
        return 0;
      case T.One:
        return 1;
      case T.False:
        return false;
      case T.True:
        return true;
      case T.Double:
        return this.f64();
      case T.String:
        return this.string();
      case T.EmptyString:
        return "";
      case T.BigInt:
        return this.bigint();
      case T.Date:
        return this.add(new Date(this.f64()));
      case T.RegExp: {
        const source = this.string();
        return this.add(new RegExp(source, this.string()));
      }
      case T.TrueObject:
        return this.add(Object(true));
      case T.FalseObject:
        return this.add(Object(false));
      case T.NumberObject:
        return this.add(Object(this.f64()));
      case T.StringObject:
        return this.add(Object(this.string()));
      case T.EmptyStringObject:
        return this.add(Object(""));
      case T.BigIntObject:
        return this.add(Object(this.bigint()));
      case T.ObjectReference: {
        const i = this.index(this.objects.length);
        if (i >= this.objects.length) throw undeserializable();
        return this.objects[i];
      }
      case T.ArrayBuffer: {
        const n = Number(this.u64());
        this.#need(n);
        const buf = this.bytes.slice(this.at, this.at + n).buffer;
        this.at += n;
        return this.add(buf);
      }
      case T.ArrayBufferView: {
        const sub = this.u8();
        const offset = Number(this.u64());
        const length = Number(this.u64());
        const buffer = this.value();
        const C = VIEWS.find(([, s]) => s === sub)?.[0] as (new (b: ArrayBuffer, o: number, n: number) => unknown) & { BYTES_PER_ELEMENT?: number };
        if (!C || !(buffer instanceof ArrayBuffer)) throw undeserializable();
        return this.add(new C(buffer, offset, sub === 0 ? length : length / (C.BYTES_PER_ELEMENT ?? 1)));
      }
      case T.Array: {
        const out = this.add(new Array(this.u32()));
        for (let head = this.u32(); ; head = this.u32()) {
          if (head === TERMINATOR) return out;
          if (head === NON_INDEX_PROPERTIES) return this.properties(out as unknown as Record<string, unknown>), out;
          out[head] = this.value();
        }
      }
      case T.Object: {
        const out = this.add({} as Record<string, unknown>);
        this.properties(out);
        return out;
      }
      case T.MapObject: {
        const out = this.add(new Map());
        while (this.bytes[this.at] !== T.NonMapProperties) {
          const k = this.value();
          out.set(k, this.value());
        }
        this.at++;
        this.properties(out as unknown as Record<string, unknown>);
        return out;
      }
      case T.SetObject: {
        const out = this.add(new Set());
        while (this.bytes[this.at] !== T.NonSetProperties) out.add(this.value());
        this.at++;
        this.properties(out as unknown as Record<string, unknown>);
        return out;
      }
      case T.ErrorInstance: {
        const type = this.u8();
        const message = this.nullableString();
        this.u32();
        this.u32();
        this.nullableString();
        const stack = this.nullableString();
        const err = new (ERROR_CTORS[type] ?? Error)(message);
        if (message === undefined) delete (err as { message?: string }).message;
        if (stack !== undefined) Object.defineProperty(err, "stack", { value: stack, writable: true, configurable: true, enumerable: false });
        return this.add(err);
      }
    }
    throw undeserializable();
  }
}

/** Bun's envelope for values holding Buffers: `[value, buffers]`, the Buffers made Buffers again on the way back. */
function tagBuffers(value: unknown): [unknown, unknown[]] | null {
  let buffers: unknown[] | null = null;
  const seen = new Set<object>();
  const stack = [value];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (ArrayBuffer.isView(cur)) {
      if (Buffer.isBuffer(cur)) (buffers ??= []).push(cur);
      continue;
    }
    if (cur instanceof Map) cur.forEach((v, k) => stack.push(k, v));
    else if (cur instanceof Set) cur.forEach((v) => stack.push(v));
    else
      for (const k of Object.keys(cur)) {
        const d = Object.getOwnPropertyDescriptor(cur, k);
        if (d && "value" in d) stack.push(d.value);
      }
  }
  return buffers ? [value, buffers] : null;
}

function encode(value: unknown): Uint8Array {
  const w = new Writer();
  w.u32(VERSION);
  w.value(value);
  return w.bytes.subarray(0, w.length);
}

function serialize(value: unknown): Buffer {
  const tagged = tagBuffers(value);
  if (!tagged) return Buffer.from(encode(value));
  const payload = encode(tagged);
  const out = Buffer.allocUnsafe(ENVELOPE.length + payload.length);
  out.set(ENVELOPE);
  out.set(payload, ENVELOPE.length);
  return out;
}

function decode(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  if (r.u32() > VERSION) throw undeserializable();
  return r.value();
}

function deserialize(value: unknown): unknown {
  let bytes: Uint8Array;
  if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) bytes = new Uint8Array(value);
  else throw new TypeError("First argument must be an ArrayBuffer");
  if (bytes.length >= ENVELOPE.length && ENVELOPE.every((b, i) => bytes[i] === b)) {
    const envelope = decode(bytes.subarray(ENVELOPE.length));
    if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[1]) || !envelope[1].every((b) => b instanceof Uint8Array)) throw new Error("failed to parse serialized buffer envelope");
    for (const b of envelope[1]) Object.setPrototypeOf(b, Buffer.prototype);
    return envelope[0];
  }
  return decode(bytes);
}

// ---- heap statistics ----

const memory = () => (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;

function getHeapStatistics() {
  const m = memory();
  const used = m?.usedJSHeapSize ?? 0;
  const total = m?.totalJSHeapSize ?? 0;
  const limit = m?.jsHeapSizeLimit ?? 0;
  return {
    total_heap_size: total,
    total_heap_size_executable: total >> 1,
    total_physical_size: total,
    total_available_size: Math.max(0, limit - used),
    used_heap_size: used,
    total_allocated_bytes: total,
    heap_size_limit: limit,
    malloced_memory: used,
    peak_malloced_memory: total,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 8192,
    used_global_handles_size: 2208,
    external_memory: 0,
  };
}

const SPACES = ["read_only_space", "new_space", "old_space", "code_space", "shared_space", "trusted_space", "new_large_object_space", "large_object_space", "code_large_object_space", "shared_large_object_space", "shared_trusted_space", "shared_trusted_large_object_space", "trusted_large_object_space"];

function getHeapSpaceStatistics() {
  const m = memory();
  return SPACES.map((space_name) => {
    const heap = space_name === "old_space";
    const used = heap ? (m?.usedJSHeapSize ?? 0) : 0;
    const size = heap ? (m?.totalJSHeapSize ?? 0) : 0;
    return { space_name, space_size: size, space_used_size: used, space_available_size: Math.max(0, size - used), physical_space_size: size };
  });
}

const notImplemented = (what: string) =>
  function () {
    throw Object.assign(new Error(`node:v8 ${what} is not yet implemented in Bun.`), { name: "NotImplementedError", code: "ERR_NOT_IMPLEMENTED" });
  };

class Serializer {
  constructor() {
    notImplemented("Serializer")();
  }
}
class Deserializer {
  constructor() {
    notImplemented("Deserializer")();
  }
}

let flags = "";
let versionTag: number | undefined;
/** A number fixed for this version and the flags given, as Bun's (a CRC-32 there; any stable hash here). */
function cachedDataVersionTag() {
  if (versionTag === undefined) {
    let h = 0x811c9dc5;
    for (const c of `bun-browser${flags}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    versionTag = h;
  }
  return versionTag;
}

const notBuildingSnapshot = () => {
  throw codeError(Error, "ERR_NOT_BUILDING_SNAPSHOT", "Operation cannot be invoked when not building startup snapshot");
};

export default {
  cachedDataVersionTag,
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
  getCppHeapStatistics: (type = "detailed") => ({ committed_size_bytes: 0, resident_size_bytes: 0, used_size_bytes: 0, space_statistics: [], type_names: [], detail_level: type }),
  setFlagsFromString(f: string) {
    if (typeof f !== "string") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "flags" argument must be of type string.`);
    flags += ` ${f}`;
    versionTag = undefined;
  },
  isStringOneByteRepresentation: (s: string) => {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
    return true;
  },
  serialize,
  deserialize,
  getHeapSnapshot: notImplemented("getHeapSnapshot"),
  writeHeapSnapshot: notImplemented("writeHeapSnapshot"),
  setHeapSnapshotNearHeapLimit: notImplemented("setHeapSnapshotNearHeapLimit"),
  takeCoverage: notImplemented("takeCoverage"),
  stopCoverage: notImplemented("stopCoverage"),
  promiseHooks: { createHook: notImplemented("createHook"), onInit: notImplemented("onInit"), onBefore: notImplemented("onBefore"), onAfter: notImplemented("onAfter"), onSettled: notImplemented("onSettled") },
  startupSnapshot: { addDeserializeCallback: notBuildingSnapshot, addSerializeCallback: notBuildingSnapshot, setDeserializeMainFunction: notBuildingSnapshot, isBuildingSnapshot: () => false },
  GCProfiler: class GCProfiler {
    #start = 0;
    start() {
      this.#start = Date.now();
    }
    stop() {
      return { version: 1, startTime: this.#start, endTime: Date.now(), statistics: [] };
    }
  },
  Serializer,
  Deserializer,
  DefaultSerializer: class DefaultSerializer extends Serializer {},
  DefaultDeserializer: class DefaultDeserializer extends Deserializer {},
};
