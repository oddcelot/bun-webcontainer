// What e.test.ts tests, for a spawned `bun test --coverage`.
export const twice = (x: number) => x * 2;

export function half(x: number) {
  if (x === 0) {
    return 0;
  }
  return x / 2;
}

export function unused() {
  return 1;
}
