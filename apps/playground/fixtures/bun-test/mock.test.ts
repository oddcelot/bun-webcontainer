import { expect, jest, mock, test } from "bun:test";

mock.module("./mock-dep", () => ({ value: "mocked", fn: () => "m" }));

test("an import after mock.module gets the mock", async () => {
  const dep = await import("./mock-dep");
  expect(Object.keys(dep).sort()).toEqual(["fn", "value"]);
  expect(dep.value).toBe("mocked");
});

test("modules that import it get the mock too", async () => {
  const subject = await import("./mock-subject");
  expect(subject.run()).toBe("mocked/m");
});

test("require gets the mock", () => {
  // (Not a literal `require("./x")`: the playground loads those before the file runs.)
  const load = require;
  expect(load("./mock-dep").value).toBe("mocked");
  expect(load("./mock-subject").run()).toBe("mocked/m");
});

test("jest.mock is the same, and a default export works", async () => {
  jest.mock("./mock-fn", () => ({ default: () => "dflt" }));
  const m = await import("./mock-fn");
  expect(m.default()).toBe("dflt");
});

test("a built-in can be mocked for imports", async () => {
  mock.module("node:os", () => ({ platform: () => "fakeos", default: { x: 1 } }));
  const os = await import("node:os");
  expect(os.platform()).toBe("fakeos");
  expect(Object.keys(os).sort()).toEqual(["default", "platform"]);
});

test("a module that is imported already can't be mocked here", async () => {
  const real = await import("./mock-other");
  expect(real.name).toBe("realother");
  let error = "";
  try {
    mock.module("./mock-other", () => ({ name: "mockedother" }));
  } catch (e) {
    error = (e as Error).message;
  }
  // Bun swaps the live bindings; here the call says what it can't do.
  expect(error === "" ? (await import("./mock-other")).name : error.startsWith("mock.module")).toBe(error === "" ? "mockedother" : true);
});
