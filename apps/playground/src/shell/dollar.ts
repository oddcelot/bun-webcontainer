// Bun.$: Bun's own JS side (bun/src/js/builtins/shell.ts: ShellPromise, ShellOutput, ShellError, $.Shell), with the
// two natives it calls supplied here: createParsedShellScript (parse.ts's template rules) and createShellInterpreter
// (interp.ts over the project's files). Where Bun's comments said why, they stay.
import { Collect, EMPTY, Shell as Interpreter, ShellEnv, normalize, type Command, type ShellFs, type Writer } from "./interp";
import { templateSource, type Source, type ShellWasm } from "./parse";

export type DollarHost = {
  fs: ShellFs;
  wasm: ShellWasm;
  builtins: Record<string, Command>;
  commands?: Record<string, Command>;
  /** Commands that run as child processes (see interp.ts ShellOptions). */
  external?: (name: string, cwd: string) => Command | undefined;
  /** Where unquiet output goes as it's written (the program's stdout and stderr). */
  stdout: Writer;
  stderr: Writer;
  /** The process's cwd and env: the defaults. */
  cwd(): string;
  env(): Record<string, string | undefined>;
  /** Bytes to the Buffer `ShellOutput.stdout` is. */
  buffer(bytes: Uint8Array): Uint8Array;
  home?: string;
};

/** Bun refuses NUL in a cwd or env string (the C side would cut it there). */
function noNul(what: string, value: string) {
  if (value.includes("\0")) throw Object.assign(new TypeError(`The ${what} must be a string without null bytes. Received ${JSON.stringify(value)}`), { code: "ERR_INVALID_ARG_VALUE" });
}

type Parsed = { source: Source; cwd?: string; env?: Record<string, string | undefined>; quiet: boolean };

/** Writes to both: what a command prints goes to the terminal and into the output `Bun.$` resolves with. */
const tee = (a: Writer, b: Writer): Writer => ({
  async write(chunk) {
    const [x] = await Promise.all([a.write(chunk), b.write(chunk)]);
    return x;
  },
});

export function createDollar(host: DollarHost) {
  function createParsedShellScript(raw: readonly string[], args: unknown[]) {
    const parsed: Parsed = { source: templateSource(raw, args), quiet: false };
    // Parse errors throw from `$` itself, as Bun's do.
    host.wasm.parse(parsed.source);
    return {
      parsed,
      setCwd(cwd: string) {
        noNul("cwd", String(cwd));
        parsed.cwd = cwd;
      },
      setEnv(env: Record<string, string | undefined>) {
        for (const [k, v] of Object.entries(env)) {
          noNul("environment variable name", k);
          if (v !== undefined) noNul("environment variable value", String(v));
        }
        parsed.env = env;
      },
      setQuiet(quiet: boolean) {
        parsed.quiet = quiet;
      },
    };
  }
  type ParsedShellScript = ReturnType<typeof createParsedShellScript>;

  function createShellInterpreter(resolve: (code: number, stdout: Uint8Array, stderr: Uint8Array) => void, reject: (e: unknown) => void, args: ParsedShellScript) {
    return {
      run() {
        const { source, cwd, env, quiet } = args.parsed;
        const out = new Collect();
        const err = new Collect();
        const vars = new Map<string, string>();
        for (const [k, v] of Object.entries(env ?? host.env())) if (v !== undefined) vars.set(k, String(v));
        const dir = normalize(cwd ?? host.cwd());
        const shellEnv = new ShellEnv(dir, new Map(), vars);
        const shell = new Interpreter({ fs: host.fs, wasm: host.wasm, builtins: host.builtins, commands: host.commands, external: host.external, home: host.home });
        // Not awaited inside run(): `then` starts it and the promise settles when it ends.
        void (async () => {
          if (!host.fs.stat(dir)?.dir) throw Object.assign(new Error(`ENOENT: No such file or directory: ${dir}`), { code: "ENOENT", path: dir });
          const script = host.wasm.parse(source);
          const code = await shell.run(script, { stdin: EMPTY, stdout: quiet ? out : tee(out, host.stdout), stderr: quiet ? err : tee(err, host.stderr) }, shellEnv, source.objs);
          resolve(code, host.buffer(out.bytes()), host.buffer(err.bytes()));
        })().catch(reject);
      },
    };
  }

  // ── Bun's shell.ts from here, typed loosely ──

  function lazyBufferToHumanReadableString(this: Uint8Array) {
    return this.toString();
  }

  class ShellError extends Error {
    #output?: ShellOutput = undefined;
    info: any;
    exitCode: any;
    stdout: any;
    stderr: any;

    constructor() {
      super("");
    }

    initialize(output: ShellOutput, code: number) {
      this.message = `Failed with exit code ${code}`;
      this.#output = output;
      this.name = "ShellError";

      Object.defineProperty(this, "info", {
        value: { exitCode: code, stderr: output.stderr, stdout: output.stdout },
        writable: true,
        enumerable: false,
        configurable: true,
      });

      this.info.stdout.toJSON = lazyBufferToHumanReadableString;
      this.info.stderr.toJSON = lazyBufferToHumanReadableString;

      this.stdout = output.stdout;
      this.stderr = output.stderr;
      this.exitCode = code;
    }

    text(encoding?: string) {
      return this.#output!.text(encoding);
    }
    json() {
      return this.#output!.json();
    }
    arrayBuffer() {
      return this.#output!.arrayBuffer();
    }
    bytes() {
      return this.#output!.bytes();
    }
    blob() {
      return this.#output!.blob();
    }
  }

  class ShellOutput {
    stdout: any;
    stderr: any;
    exitCode: number;
    constructor(stdout: any, stderr: any, exitCode: number) {
      this.stdout = stdout;
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
    text(encoding?: string) {
      return this.stdout.toString(encoding);
    }
    json() {
      return JSON.parse(this.stdout.toString());
    }
    arrayBuffer() {
      return this.stdout.buffer.slice(this.stdout.byteOffset, this.stdout.byteOffset + this.stdout.byteLength);
    }
    bytes() {
      return new Uint8Array(this.arrayBuffer());
    }
    blob() {
      return new Blob([this.stdout]);
    }
  }

  class ShellPromise extends Promise<ShellOutput> {
    #args: ParsedShellScript | undefined = undefined;
    #hasRun = false;
    #throws = true;
    #resolve!: (code: number, stdout: Uint8Array, stderr: Uint8Array) => void;
    #reject!: (error: unknown) => void;

    constructor(args: ParsedShellScript, throws: boolean) {
      // Create the error immediately so it captures the stacktrace at the point of the shell script's invocation.
      let potentialError: ShellError | undefined = new ShellError();
      let resolve: any, reject: any;
      super((res, rej) => {
        resolve = (code: number, stdout: Uint8Array, stderr: Uint8Array) => {
          const out = new ShellOutput(stdout, stderr, code);
          if (this.#throws && code !== 0) {
            potentialError!.initialize(out, code);
            rej(potentialError);
          } else {
            potentialError = undefined;
            res(out);
          }
        };
        // Only for a JS error raised by the interpreter itself; exit codes go through `resolve`.
        reject = (error: unknown) => {
          potentialError = undefined;
          rej(error);
        };
      });
      this.#throws = throws;
      this.#args = args;
      this.#hasRun = false;
      this.#resolve = resolve;
      this.#reject = reject;
    }

    cwd(newCwd?: string): this {
      this.#throwIfRunning();
      if (typeof newCwd === "undefined" || newCwd === "." || newCwd === "" || newCwd === "./") newCwd = defaultCwd ?? host.cwd();
      this.#args!.setCwd(newCwd);
      return this;
    }

    env(newEnv: Record<string, string | undefined>): this {
      this.#throwIfRunning();
      if (typeof newEnv === "undefined") newEnv = defaultEnv();
      this.#args!.setEnv(newEnv);
      return this;
    }

    #run() {
      if (!this.#hasRun) {
        this.#hasRun = true;
        // `then()` calls this, so a setup failure must reject, not throw.
        try {
          const interp = createShellInterpreter(this.#resolve, this.#reject, this.#args!);
          this.#args = undefined;
          interp.run();
        } catch (e) {
          this.#args = undefined;
          this.#reject(e);
        }
      }
    }

    #quiet(isQuiet = true): this {
      this.#throwIfRunning();
      this.#args!.setQuiet(isQuiet);
      return this;
    }

    quiet(isQuiet?: boolean): this {
      return this.#quiet(isQuiet ?? true);
    }

    nothrow(): this {
      this.#throws = false;
      return this;
    }

    throws(doThrow?: boolean): this {
      this.#throws = !!doThrow;
      return this;
    }

    async text(encoding?: string) {
      const { stdout } = (await this.#quiet(true)) as ShellOutput;
      return stdout.toString(encoding);
    }

    async json() {
      const { stdout } = (await this.#quiet(true)) as ShellOutput;
      return JSON.parse(stdout.toString());
    }

    async *lines() {
      const { stdout } = (await this.#quiet(true)) as ShellOutput;
      yield* stdout.toString().split("\n");
    }

    async arrayBuffer() {
      const { stdout } = (await this.#quiet(true)) as ShellOutput;
      return stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
    }

    async bytes() {
      return this.arrayBuffer().then((x) => new Uint8Array(x));
    }

    async blob() {
      const { stdout } = (await this.#quiet(true)) as ShellOutput;
      return new Blob([stdout]);
    }

    #throwIfRunning() {
      if (this.#hasRun) throw new Error("Shell is already running");
    }

    run(): this {
      this.#run();
      return this;
    }

    override then<TResult1 = ShellOutput, TResult2 = never>(
      onfulfilled?: ((value: ShellOutput) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      this.#run();
      return super.then(onfulfilled, onrejected);
    }

    static override get [Symbol.species]() {
      return Promise;
    }
  }

  const defaultEnv = () => host.env();
  const defaultCwd: string | undefined = undefined;

  const cwdSymbol = Symbol("cwd");
  const envSymbol = Symbol("env");
  const throwsSymbol = Symbol("throws");

  class ShellPrototype {
    [cwdSymbol]: string | undefined;
    [envSymbol]: Record<string, string | undefined> | undefined;
    [throwsSymbol] = true;

    env(newEnv: Record<string, string | undefined> | undefined) {
      if (typeof newEnv === "undefined") this[envSymbol] = undefined;
      else if (newEnv) this[envSymbol] = Object.assign({}, newEnv);
      else throw new TypeError("env must be an object or undefined");
      return this;
    }

    cwd(newCwd: string | undefined) {
      if (typeof newCwd === "undefined" || typeof newCwd === "string") {
        if (newCwd === "." || newCwd === "" || newCwd === "./") newCwd = defaultCwd ?? host.cwd();
        this[cwdSymbol] = newCwd;
      } else throw new TypeError("cwd must be a string or undefined");
      return this;
    }

    nothrow() {
      this[throwsSymbol] = false;
      return this;
    }

    throws(doThrow: boolean | undefined) {
      this[throwsSymbol] = !!doThrow;
      return this;
    }
  }

  const make = (self: any) =>
    function (first: TemplateStringsArray, ...rest: unknown[]) {
      if (first?.raw === undefined) throw new Error("Please use '$' as a tagged template function: $`cmd arg1 arg2`");
      const parsed = createParsedShellScript(first.raw, rest);
      const cwd = self()[cwdSymbol];
      const env = self()[envSymbol];
      const throws = self()[throwsSymbol];
      // cwd must be set before env or else it will be injected into env as "PWD=/"
      if (cwd) parsed.setCwd(cwd);
      if (env) parsed.setEnv(env);
      return new ShellPromise(parsed, throws);
    };

  const BunShell: any = make(() => BunShell);

  function Shell(this: unknown) {
    if (!new.target) throw new TypeError("Class constructor Shell cannot be invoked without 'new'");
    const shell: any = make(() => shell);
    const prototype = new.target.prototype;
    Object.setPrototypeOf(shell, prototype && typeof prototype === "object" ? prototype : ShellPrototype.prototype);
    Object.defineProperty(shell, "name", { value: "Shell", configurable: true, enumerable: true });
    shell[cwdSymbol] = defaultCwd;
    shell[envSymbol] = undefined;
    shell[throwsSymbol] = true;
    return shell;
  }

  Shell.prototype = ShellPrototype.prototype;
  Object.setPrototypeOf(Shell, ShellPrototype);
  Object.setPrototypeOf(BunShell, ShellPrototype.prototype);

  BunShell[cwdSymbol] = defaultCwd;
  BunShell[envSymbol] = undefined;
  BunShell[throwsSymbol] = true;

  Object.defineProperties(BunShell, {
    Shell: { value: Shell, enumerable: true },
    ShellPromise: { value: ShellPromise, enumerable: true },
    ShellError: { value: ShellError, enumerable: true },
    braces: { value: (pattern: string) => host.wasm.braces(pattern), enumerable: true },
    escape: { value: escape, enumerable: true },
  });

  return BunShell;
}

/** `$.escape`: a string as one shell word (Bun's escape_bun_str with quotes, when it needs any). */
export function escape(input: string): string {
  // Bun converts as JS's ToString does, which refuses a symbol (with JSC's wording).
  if (typeof input === "symbol") throw new TypeError("Cannot convert a symbol to a string");
  const s = String(input);
  if (!/[~[\]#;\n\t\r*?{,}`$=()0-9|><&'" \\\b]/.test(s) && s !== "") return s;
  let out = '"';
  for (const c of s) {
    if (c === "$" || c === "`" || c === '"' || c === "\\") out += "\\" + c;
    else if (c === "\b") out += '\b""';
    else out += c;
  }
  return out + '"';
}
