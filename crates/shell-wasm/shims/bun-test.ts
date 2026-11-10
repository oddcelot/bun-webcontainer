// The part of `bun:test` Bun's parse.test.ts uses, collecting tests for test.ts to run.
import assert from "node:assert/strict";

export type Case = { name: string; fn: () => unknown; todo?: boolean };
export const cases: Case[] = [];
const prefix: string[] = [];
let todo = false;

export function describe(name: string, fn: () => void) {
  prefix.push(name);
  fn();
  prefix.pop();
}
describe.todo = (name: string, fn: () => void) => {
  const was = todo;
  todo = true;
  describe(name, fn);
  todo = was;
};
export function test(name: string, fn: () => unknown) {
  cases.push({ name: [...prefix, name].join(" > "), fn, todo });
}
test.todo = (name: string, fn: () => unknown) => cases.push({ name: [...prefix, name].join(" > "), fn, todo: true });
export const it = test;

export function expect(actual: unknown) {
  return {
    toEqual: (expected: unknown) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected))),
    toBe: (expected: unknown) => assert.equal(actual, expected),
  };
}
