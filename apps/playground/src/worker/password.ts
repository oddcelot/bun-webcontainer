// `Bun.password`: argon2 and bcrypt from resolve-wasm (the crates Bun uses), with PasswordObject.rs's argument handling
// and errors around them. The sync forms run here; the async ones in a worker of their own (passwordWorker.ts), so a
// hash (about a quarter second with the defaults) doesn't block the program and argon2's memory goes away with it.
import { passwordHash, passwordVerify, PasswordError, resolverModule, type PasswordAlgorithm } from "../resolver";
import type { PasswordJob, PasswordResult } from "./passwordWorker";
import { codeError } from "./node/errors";
import { CryptoHasher } from "./node/crypto";

type Options = { algorithm?: string; cost?: unknown; memoryCost?: unknown; timeCost?: unknown };
type Algorithm = { name: PasswordAlgorithm; memoryCost: number; timeCost: number };

const UNKNOWN = 'unknown algorithm, expected one of: "bcrypt", "argon2id", "argon2d", "argon2i" (default is "argon2id")';
const ALGORITHMS = ["argon2d", "argon2i", "argon2id", "bcrypt"];
/** argon2id's interactive preset (64 MiB, 2 passes) and bcrypt's 10 rounds, as Bun's defaults. */
const ARGON2_DEFAULTS = { memoryCost: 65536, timeCost: 2 };
const BCRYPT_COST = 10;

const invalid = (message: string) => codeError(TypeError, "ERR_INVALID_ARG_TYPE", message);
const argumentType = (fn: string, field: string, type: string) => invalid(`Expected ${field} to be a ${type} for '${fn}'.`);

/** The bytes of a password or hash: a string's UTF-8, a buffer's bytes, a Blob's contents, anything else's `String()`. */
function bytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof Blob) return new Uint8Array(new (globalThis as unknown as { FileReaderSync: new () => { readAsArrayBuffer(b: Blob): ArrayBuffer } }).FileReaderSync().readAsArrayBuffer(v));
  return new TextEncoder().encode(typeof v === "string" ? v : String(v));
}

function label(fn: string, v: string): PasswordAlgorithm {
  if (!ALGORITHMS.includes(v)) throw argumentType(fn, "algorithm", UNKNOWN);
  return v as PasswordAlgorithm;
}

function cost(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "number") throw argumentType("hash", name, "number");
  return v;
}

/** `AlgorithmValue::from_argument`. */
function algorithmOf(arg: unknown): Algorithm {
  if (arg === undefined || arg === null) return { name: "argon2id", ...ARGON2_DEFAULTS };
  if (typeof arg === "string") {
    const name = label("hash", arg);
    return { name, ...(name === "bcrypt" ? { memoryCost: BCRYPT_COST, timeCost: 0 } : ARGON2_DEFAULTS) };
  }
  const o = arg as Options;
  if (typeof o.algorithm !== "string" || !o.algorithm) throw argumentType("hash", "options.algorithm", "string");
  const name = label("hash", o.algorithm);
  if (name === "bcrypt") {
    const rounds = cost(o.cost, "cost") ?? BCRYPT_COST;
    if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) throw invalid("Rounds must be an integer between 4 and 31");
    return { name, memoryCost: rounds, timeCost: 0 };
  }
  const a = { name, ...ARGON2_DEFAULTS };
  const t = cost(o.timeCost, "timeCost");
  if (t !== undefined) {
    if (!(t >= 1)) throw invalid("Time cost must be greater than 0");
    if (!Number.isInteger(t) || t > 0xffffffff) throw invalid("Time cost must be an integer between 1 and 4294967295");
    a.timeCost = t;
  }
  const m = cost(o.memoryCost, "memoryCost");
  if (m !== undefined) {
    if (!(m >= 8)) throw invalid("Memory cost must be at least 8");
    if (!Number.isInteger(m) || m > 0xffffffff) throw invalid("Memory cost must be an integer between 8 and 4294967295");
    a.memoryCost = m;
  }
  return a;
}

/** Bun's error for a failed hash or verification: `code` is the error name as `PASSWORD_UPPER_SNAKE`. */
function failure(e: unknown, verb: string): unknown {
  if (!(e instanceof PasswordError)) return e;
  const err = new Error(`Password ${verb} failed with error "${e.message}"`);
  return Object.assign(err, { code: `PASSWORD${e.message.replace(/[A-Z]/g, "_$&").toUpperCase()}` });
}

/** As Bun: bcrypt reads 72 bytes at most, so a longer password is hashed with SHA-512 first. */
const forBcrypt = (pw: Uint8Array) => (pw.length > 72 ? new Uint8Array(new CryptoHasher("sha512").update(pw).digest() as Uint8Array) : pw);

/** What resolve-wasm hashes: the password (bcrypt's prehashed when long), a fresh salt, the algorithm and costs. */
function hashJob(pw: Uint8Array, a: Algorithm) {
  const bcrypt = a.name === "bcrypt";
  const salt = crypto.getRandomValues(new Uint8Array(bcrypt ? 16 : 32));
  return { op: "hash" as const, password: bcrypt ? forBcrypt(pw) : pw, salt, algorithm: a.name, memoryCost: a.memoryCost, timeCost: a.timeCost };
}

/** `PasswordObject::verify`: the algorithm given, or the one the hash names; null (false) for an empty password or hash. */
function verifyJob(pw: Uint8Array, hash: Uint8Array, algorithm: PasswordAlgorithm | undefined) {
  if (!pw.length || !hash.length) return null;
  const text = new TextDecoder().decode(hash);
  const sniffed = !text.startsWith("$")
    ? undefined
    : text.startsWith("$argon2d$")
      ? "argon2d"
      : text.startsWith("$argon2i$")
        ? "argon2i"
        : text.startsWith("$argon2id$")
          ? "argon2id"
          : text.startsWith("$bcrypt") || text.startsWith("$2")
            ? "bcrypt"
            : undefined;
  const name = algorithm ?? sniffed;
  if (!name) throw failure(new PasswordError("UnsupportedAlgorithm"), "verification");
  return { op: "verify" as const, password: name === "bcrypt" ? forBcrypt(pw) : pw, hash, algorithm: name };
}

type Job = PasswordJob extends infer J ? (J extends PasswordJob ? Omit<J, "id"> : never) : never;

/** Runs a job on this thread. */
function runNow(job: Job): string | boolean {
  try {
    return job.op === "hash" ? passwordHash(job.password, job.salt, job.algorithm, job.memoryCost, job.timeCost) : passwordVerify(job.password, job.hash, job.algorithm);
  } catch (e) {
    throw failure(e, job.op === "hash" ? "hashing" : "verification");
  }
}

const later = <T>(f: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
  try {
    resolve(f());
  } catch (e) {
    reject(e);
  }
}));

/** The password worker stays this long after its last job, then goes, and its memory with it. */
const IDLE_MS = 10_000;
type Pending = { resolve(v: string | boolean): void; reject(e: unknown): void; verb: string };
type Thread = { worker: Worker; ready: Promise<void>; pending: Map<number, Pending>; idle?: ReturnType<typeof setTimeout> };
let thread: Thread | undefined;
let nextJob = 0;

function stopThread(t: Thread, err?: unknown) {
  if (thread === t) thread = undefined;
  clearTimeout(t.idle);
  t.worker.terminate();
  for (const p of t.pending.values()) p.reject(err);
  t.pending.clear();
}

/** The password worker, started on first use; undefined where workers can't start one (then jobs run here). */
function passwordThread(): Thread | undefined {
  if (thread) return thread;
  const module = resolverModule();
  if (!module || typeof Worker === "undefined") return undefined;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./passwordWorker.ts", import.meta.url), { type: "module", name: "Bun.password" });
  } catch {
    return undefined;
  }
  // The module goes first: the worker instantiates it before any job.
  const t: Thread = { worker, ready: module.then((m) => worker.postMessage({ module: m })), pending: new Map() };
  worker.onmessage = (e: MessageEvent<PasswordResult>) => {
    const r = e.data;
    const p = t.pending.get(r.id);
    if (!p) return;
    t.pending.delete(r.id);
    if ("value" in r) p.resolve(r.value);
    else p.reject("password" in r ? failure(new PasswordError(r.password), p.verb) : new Error(r.message));
    if (!t.pending.size) t.idle = setTimeout(() => stopThread(t), IDLE_MS);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    stopThread(t, new Error(`Bun.password worker failed: ${e.message}`));
  };
  return (thread = t);
}

/** Runs a job in the password worker, or on this thread a task later when there is none. */
function runAsync(job: Job): Promise<string | boolean> {
  const t = passwordThread();
  if (!t) return later(() => runNow(job));
  clearTimeout(t.idle);
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    t.pending.set(id, { resolve, reject, verb: job.op === "hash" ? "hashing" : "verification" });
    // Copies: a view (a pooled Buffer) would send its whole backing buffer.
    const copy = job.op === "hash" ? { ...job, password: job.password.slice() } : { ...job, password: job.password.slice(), hash: job.hash.slice() };
    t.ready.then(() => t.worker.postMessage({ ...copy, id }), (err) => stopThread(t, err));
  });
}

function prepareHash(password: unknown, algorithm: unknown): [Uint8Array, Algorithm] {
  const pw = bytes(password);
  const a = algorithmOf(algorithm);
  if (!pw.length) throw invalid("password must not be empty");
  return [pw, a];
}

const verifyLabel = (v: unknown) => (v === undefined || v === null ? undefined : label("verify", String(v)));

export const password = {
  hash(password: unknown, algorithm?: unknown): Promise<string> {
    const [pw, a] = prepareHash(password, algorithm);
    return runAsync(hashJob(pw, a)) as Promise<string>;
  },
  hashSync(password: unknown, algorithm?: unknown): string {
    return runNow(hashJob(...prepareHash(password, algorithm))) as string;
  },
  verify(password: unknown, hash: unknown, algorithm?: unknown): Promise<boolean> {
    const [pw, h, a] = [bytes(password), bytes(hash), verifyLabel(algorithm)];
    try {
      const job = verifyJob(pw, h, a);
      return job ? (runAsync(job) as Promise<boolean>) : Promise.resolve(false);
    } catch (e) {
      // An unknown hash format rejects, as in Bun; bad arguments (above) throw.
      return Promise.reject(e);
    }
  },
  verifySync(password: unknown, hash: unknown, algorithm?: unknown): boolean {
    const job = verifyJob(bytes(password), bytes(hash), verifyLabel(algorithm));
    return job ? (runNow(job) as boolean) : false;
  },
};
