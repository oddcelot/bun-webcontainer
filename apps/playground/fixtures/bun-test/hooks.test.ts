import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// A hook that throws fails as a test of its own, "<suite> > (unnamed)".
const ran: string[] = [];

describe("d", () => {
  afterAll(() => {
    throw new Error("afterAll threw");
  });
  test("passes before it", () => {});
});

describe("before", () => {
  beforeAll(() => {
    throw new Error("beforeAll threw");
  });
  beforeAll(() => void ran.push("second beforeAll"));
  afterAll(() => void ran.push("afterAll after a failed beforeAll"));
  test("does not run", () => {});
  describe("nested", () => {
    test("does not run either", () => {});
  });
});

describe("each", () => {
  beforeEach(() => {
    throw new Error("beforeEach threw");
  });
  test("one", () => {});
  test("two", () => {});
});

describe("after each", () => {
  afterEach(() => {
    throw new Error("afterEach threw");
  });
  test("one", () => {});
});

describe("outer", () => {
  beforeAll(() => void ran.push("outer beforeAll"));
  describe("inner", () => {
    afterAll(() => {
      throw new Error("inner afterAll threw");
    });
    test("x", () => {});
  });
});

// Without -t or .only, the hooks run around a suite whose tests are all skipped, or that has none.
describe("all skipped", () => {
  beforeAll(() => void ran.push("beforeAll of skipped tests"));
  test.skip("skipped", () => {});
});
describe("empty", () => {
  afterAll(() => void ran.push("afterAll of an empty suite"));
});

// In a skipped suite, each beforeAll and afterAll counts as a skipped test.
describe.skip("skipped suite", () => {
  beforeAll(() => {});
  afterAll(() => {});
  test("t", () => {});
});

test("the hooks ran", () => {
  expect(ran).toEqual(["afterAll after a failed beforeAll", "outer beforeAll", "beforeAll of skipped tests", "afterAll of an empty suite"]);
});
