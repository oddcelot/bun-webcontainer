// Generators count as called when they are called, before their body first runs.
export function* rest(...xs: number[]) {
  yield xs.length;
}

export function* restAfter(a: number, ...xs: number[]) {
  yield a + xs.length;
}

export function* strict(a: number) {
  "use strict";
  yield a;
}

export async function* asyncRest(...xs: number[]) {
  yield xs;
}

export function* neverCalled(...xs: number[]) {
  yield xs;
}

export function* resumed(...xs: number[]) {
  yield Array.isArray(xs) && xs.length;
}

// What follows `?.#private` counts on its own.
export class Box {
  #v = 1;
  static peek(b?: Box) {
    return b
      ?.#v;
  }
  static call(b?: Box) {
    return b
      ?.#get();
  }
  static deep(b?: { box?: Box }) {
    return b?.box
      ?.#v;
  }
  #get() {
    return this.#v;
  }
}

export function* restPattern(...[a, b = 2]: number[]) {
  yield a + b;
}

export function* restPatternNever(...[a]: number[]) {
  yield a;
}

export function* restNested(...[a, , ...more]: number[]) {
  yield [a, more.length, Array.isArray(more)];
}

export function* restObject(...{ length }: number[]) {
  yield length;
}
