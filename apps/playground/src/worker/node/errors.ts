const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, "no such file or directory"],
  EEXIST: [-17, "file already exists"],
  ENOTDIR: [-20, "not a directory"],
  EISDIR: [-21, "illegal operation on a directory"],
  ENOTEMPTY: [-39, "directory not empty"],
  EBADF: [-9, "bad file descriptor"],
  EINVAL: [-22, "invalid argument"],
  EPERM: [-1, "operation not permitted"],
};

export type FsError = Error & { errno: number; code: string; syscall: string; path?: string; dest?: string };

/** An error shaped like Node's: `ENOENT: no such file or directory, open '/x'`. */
export function fsError(code: string, syscall: string, path?: string, dest?: string): FsError {
  const [errno, desc] = ERRNO[code];
  const err = new Error(`${code}: ${desc}, ${syscall}${path !== undefined ? ` '${path}'` : ""}${dest !== undefined ? ` -> '${dest}'` : ""}`) as FsError;
  // Bun's order.
  err.code = code;
  if (path !== undefined) err.path = path;
  if (dest !== undefined) err.dest = dest;
  err.syscall = syscall;
  err.errno = errno;
  return err;
}

/**
 * A system error (fsError's) as an asynchronous API reports it: Bun makes those off the JavaScript stack, so they have
 * no `stack` (`util.inspect` shows `[Error: ENOENT: …]`). Other errors are left alone.
 */
export function asyncError<T>(e: T): T {
  if (e instanceof Error && "syscall" in e && "errno" in e) delete (e as { stack?: string }).stack;
  return e;
}

/** An error with a Node `code`, e.g. ERR_INVALID_ARG_TYPE. */
export function codeError<T extends ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor>(Ctor: T, code: string, message: string): Error & { code: string } {
  const err = new Ctor(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** A module whose listed functions throw when called; property access never throws. */
export function stubModule(name: string, fns: string, extra: object = {}): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const k of fns.split(" ")) {
    m[k] = function () {
      throw new Error(`node:${name}.${k} is not supported in the playground`);
    };
  }
  return Object.assign(m, extra);
}
