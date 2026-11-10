// Tests that spawn a Bun need a real one: they're skipped (test.ts counts them).
export const bunEnv = {};
export const bunExe = () => {
  throw new SkipError("needs a native Bun");
};
export class SkipError extends Error {}
