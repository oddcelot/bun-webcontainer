// util.parseArgs, following Node's algorithm: tokenize, then check and store each token, then apply defaults.
import { codeError } from "./errors";
import process from "./process";

type OptionConfig = { type: "boolean" | "string"; short?: string; multiple?: boolean; default?: unknown };
type Config = { args?: string[]; options?: Record<string, OptionConfig>; strict?: boolean; allowPositionals?: boolean; allowNegative?: boolean; tokens?: boolean };
type Token =
  | { kind: "option"; name: string; rawName: string; index: number; value: string | undefined; inlineValue: boolean | undefined }
  | { kind: "positional"; index: number; value: string }
  | { kind: "option-terminator"; index: number };

const isOptionLike = (a: string | undefined) => a !== undefined && a.length > 1 && a[0] === "-";

export function parseArgs(config: Config = {}) {
  const args = config.args ?? process.argv.slice(2);
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const allowNegative = config.allowNegative ?? false;
  const longOf = (short: string) => Object.keys(options).find((k) => options[k].short === short) ?? short;
  const takesValue = (name: string) => options[name]?.type === "string";

  const tokens: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const index = i;
    if (arg === "--") {
      tokens.push({ kind: "option-terminator", index });
      for (i++; i < args.length; i++) tokens.push({ kind: "positional", index: i, value: args[i] });
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) tokens.push({ kind: "option", name: arg.slice(2, eq), rawName: arg.slice(0, eq), index, value: arg.slice(eq + 1), inlineValue: true });
      else {
        const name = arg.slice(2);
        const value = takesValue(name) && !isOptionLike(args[i + 1]) ? args[++i] : undefined;
        tokens.push({ kind: "option", name, rawName: arg, index, value, inlineValue: value === undefined ? undefined : false });
      }
    } else if (arg.length > 1 && arg[0] === "-") {
      const first = longOf(arg[1]);
      if (arg.length > 2 && takesValue(first)) {
        tokens.push({ kind: "option", name: first, rawName: arg.slice(0, 2), index, value: arg.slice(2), inlineValue: true });
      } else if (arg.length > 2) {
        // A group of short flags: `-abc` is `-a -b -c`; one that takes a value takes the rest.
        for (let j = 1; j < arg.length; j++) {
          const name = longOf(arg[j]);
          if (takesValue(name) && j < arg.length - 1) {
            tokens.push({ kind: "option", name, rawName: `-${arg[j]}`, index, value: arg.slice(j + 1), inlineValue: true });
            break;
          }
          const value = takesValue(name) && j === arg.length - 1 && !isOptionLike(args[i + 1]) ? args[i + 1] : undefined;
          tokens.push({ kind: "option", name, rawName: `-${arg[j]}`, index, value, inlineValue: value === undefined ? undefined : false });
          if (value !== undefined) i++;
        }
      } else {
        const value = takesValue(first) && !isOptionLike(args[i + 1]) ? args[++i] : undefined;
        tokens.push({ kind: "option", name: first, rawName: arg, index, value, inlineValue: value === undefined ? undefined : false });
      }
    } else tokens.push({ kind: "positional", index, value: arg });
  }

  const values: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  for (const t of tokens) {
    if (t.kind === "positional") {
      if (!allowPositionals) throw codeError(TypeError, "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", `Unexpected argument '${t.value}'. This command does not take positional arguments`);
      positionals.push(t.value);
      continue;
    }
    if (t.kind !== "option") continue;
    let { name } = t;
    let value: unknown = t.value;
    if (allowNegative && name.startsWith("no-") && options[name.slice(3)]?.type === "boolean" && t.value === undefined) {
      name = name.slice(3);
      value = false;
    }
    const opt = options[name];
    if (strict) {
      if (!opt) {
        const hint = t.rawName.startsWith("--") ? "" : ` Did you forget to escape it?`;
        throw codeError(TypeError, "ERR_PARSE_ARGS_UNKNOWN_OPTION", `Unknown option '${t.rawName}'.${hint} To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${t.rawName}"`);
      }
      const short = opt.short ? `-${opt.short}, ` : "";
      if (opt.type === "string" && typeof value !== "string") throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${short}--${name} <value>' argument missing`);
      if (opt.type === "boolean" && t.value !== undefined) throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${short}--${name}' does not take an argument`);
    }
    if (value === undefined) value = true;
    if (opt?.multiple) ((values[name] ??= []) as unknown[]).push(value);
    else values[name] = value;
  }
  for (const [name, opt] of Object.entries(options)) if (opt.default !== undefined && !(name in values)) values[name] = opt.default;

  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}
