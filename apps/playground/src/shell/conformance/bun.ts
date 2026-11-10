// `import { $ } from "bun"` in the tests: the playground's Bun.$ (globalThis.Bun, set by run.ts).
export const $ = (globalThis as any).Bun.$;
export const file = (globalThis as any).Bun.file;
export const which = (globalThis as any).Bun.which;
export default (globalThis as any).Bun;
// Imported as a value by test_builder.ts (`import { $, ShellExpression } from "bun"`), though only a type.
export const ShellExpression = undefined;
