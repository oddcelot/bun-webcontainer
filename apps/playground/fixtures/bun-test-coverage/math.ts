export function add(a: number, b: number) {
  return a + b;
}

export function sub(a: number, b: number) {
  return a - b;
}

export const mul = (a: number, b: number) => a * b;

export class Calc {
  value = 0;
  handler = () => this.value;
  inc() {
    this.value++;
    return this;
  }
  dec() {
    this.value--;
    return this;
  }
  static {
    void 0;
  }
}

export function branchy(x: number) {
  if (x > 0) {
    return "pos";
  } else if (x < 0) {
    return "neg";
  }
  // a comment
  const y = [1, 2, 3].map((v) => v * 2);
  return y.length === 3
    ? "zero"
    : "never";
}

export function loops(n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2) continue;
    s += i;
  }
  while (s > 100) {
    s--;
  }
  do {
    s++;
  } while (s < 2);
  for (const k in { a: 1 }) s += k.length;
  return s;
}

export function sw(x: string) {
  switch (x) {
    case "a":
      return 1;
    case "b":
    case "c":
      return 2;
    default:
      return 3;
  }
}

export function tc(f: () => void) {
  try {
    f();
  } catch (e) {
    return "caught";
  } finally {
    void f;
  }
  return "ok";
}

export function logic(a: any, b: any) {
  const x = a &&
    b;
  const y = a ||
    b;
  const z = a ??
    b;
  a ||= () => 1;
  const w = a?.foo?.bar;
  return [x, y, z, w];
}

export function defaults(a = 1, { b = 2 } = {}) {
  return a + b;
}

export async function later(x: number) {
  const v = await Promise.resolve(x);
  if (v > 1) {
    return v;
  }
  return 0;
}

export function* gen() {
  yield 1;
  yield 2;
}

export function outer() {
  const inner = () => {
    return 1;
  };
  return inner;
}
