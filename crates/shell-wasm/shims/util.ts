// util.ts's `redirect`, and a TestBuilder that only parses: `.error(msg)` checks the parse error's message.
import { templateSource } from "../../../apps/playground/src/shell/parse.ts";
import { SkipError } from "./harness.ts";

const defaultRedirect = { __unused: 0, append: false, stderr: false, stdin: false, stdout: false, duplicate_out: false };
export const redirect = (opts?: Partial<typeof defaultRedirect>) => (opts === undefined ? defaultRedirect : { ...defaultRedirect, ...opts });

export function createTestBuilder(_path: string) {
  return {
    command(strings: TemplateStringsArray, ...values: unknown[]) {
      let expected: string | undefined;
      const b = {
        error(msg: string) {
          expected = msg;
          return b;
        },
        async run() {
          if (expected === undefined) throw new SkipError("runs the command");
          let got: string | undefined;
          try {
            (globalThis as any).__shellParse(templateSource(strings.raw, values));
          } catch (e) {
            got = (e as Error).message;
          }
          if (got !== expected) throw new Error(`expected the error ${JSON.stringify(expected)}, got ${JSON.stringify(got ?? "no error")}`);
        },
        /** A test of its own, under the current describe. */
        runAsTest(name: string) {
          (globalThis as any).test(name, () => b.run());
        },
      };
      return b;
    },
  };
}
