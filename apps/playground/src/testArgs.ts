// `bun test`'s command line as the playground takes it: the console's `bun test` (shell.ts) and a spawned one
// (worker/processes.ts) split it the same way, and the worker reads what the flags ask of the run (testOptions, for
// worker/node/test.ts runTestFiles) and of coverage (coverage/options.ts), with Bun's messages for values it rejects
// (runtime/cli/Arguments.rs).

/** Flags that take a value: the next argument, or `--name=value`. */
const VALUE_FLAGS = ["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--coverage-reporter", "--coverage-dir"];
/** Flags without one, but `--bail`, which takes one only as `--bail=<n>`. */
const FLAGS = ["-u", "--update-snapshots", "--coverage", "--todo", "--only", "--bail"];

/**
 * `bun test <args>`: the test file filters, and the flags (`--name=value` for one with a value), or an error for a flag
 * the playground doesn't take or a value that is missing.
 */
export function splitTestArgs(args: string[]): { filters: string[]; flags: string[]; error?: undefined } | { error: string } {
  const filters: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) {
      filters.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (VALUE_FLAGS.includes(name)) {
      if (eq >= 0) flags.push(a);
      else if (i + 1 < args.length) flags.push(`${a}=${args[++i]}`);
      else return { error: `error: The argument '${a}' requires a value but none was supplied.` };
    } else if (FLAGS.includes(name) && (eq < 0 || name === "--bail")) flags.push(a);
    else return { error: `error: bun test ${a} is not supported here` };
  }
  return { filters, flags };
}

/** What a test run's flags ask for. */
export type TestOptions = {
  /** `-u`: snapshots that differ are written anew. */
  update: boolean;
  /** `-t`: only the tests whose name (with their describe blocks', joined by spaces) matches run. */
  namePattern?: RegExp;
  /** `--timeout`: each test's, where it sets none. */
  timeout?: number;
  /** `--bail`: the run stops after this many failures. */
  bail?: number;
  /** `--rerun-each`: each file runs this many times. */
  rerunEach?: number;
  /** `--todo`: `test.todo` tests with a body run too. */
  todo: boolean;
  /** `--only`: only `.only` tests run, in every file. */
  only: boolean;
};

/** The options of `flags` (splitTestArgs's; coverage's are coverage/options.ts's). Throws Bun's message for a bad value. */
export function testOptions(flags: string[]): TestOptions {
  const o: TestOptions = { update: false, todo: false, only: false };
  /** A count as Bun parses it (an unsigned integer). */
  const count = (flag: string, v: string) => {
    if (/^\d+$/.test(v)) return Number(v);
    throw new Error(`${flag} expects a number: ${/^-\d+$/.test(v) ? "Overflow" : "InvalidCharacter"}`);
  };
  for (const f of flags) {
    const eq = f.indexOf("=");
    const name = eq < 0 ? f : f.slice(0, eq);
    const v = f.slice(eq + 1);
    if (name === "-u" || name === "--update-snapshots") o.update = true;
    else if (name === "--todo") o.todo = true;
    else if (name === "--only") o.only = true;
    else if (name === "-t" || name === "--test-name-pattern") {
      try {
        o.namePattern = new RegExp(v);
      } catch {
        throw new Error(`--test-name-pattern expects a valid regular expression but received ${JSON.stringify(v)}`);
      }
    } else if (name === "--timeout") {
      if (!/^\d+$/.test(v)) throw new Error(`Invalid timeout: ${JSON.stringify(v)}`);
      o.timeout = Number(v);
    } else if (name === "--bail") {
      o.bail = eq < 0 ? 1 : count("--bail", v);
      if (!o.bail) throw new Error("--bail expects a number greater than 0");
    } else if (name === "--rerun-each") o.rerunEach = count("--rerun-each", v);
  }
  return o;
}
