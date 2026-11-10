// `shellInternals.parse` over the wasm parser (test.ts sets globalThis.__shellParse).
import { templateSource } from "../../../apps/playground/src/shell/parse.ts";

const parse = (strings: TemplateStringsArray, ...values: unknown[]) =>
  JSON.stringify((globalThis as any).__shellParse(templateSource(strings.raw, values)));
export const shellInternals = { parse };
