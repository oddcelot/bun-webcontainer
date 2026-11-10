// Modules the shell tests import that the conformance run can't have (bun:ffi, bun:internal-for-testing's lexer).
import { SkipError } from "./bun-test.ts";
import { templateSource } from "../parse.ts";

const skip = () => {
  throw new SkipError("needs native Bun internals");
};
export const dlopen = skip;
export const FFIType = new Proxy({}, { get: skip });
export const shellInternals = {
  parse: (s: TemplateStringsArray, ...v: unknown[]) => JSON.stringify((globalThis as any).__shellWasm.parse(templateSource(s.raw, v))),
  lex: skip,
  builtinDisabled: () => false,
};
