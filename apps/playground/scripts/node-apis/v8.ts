// node:v8: serialize/deserialize in JavaScriptCore's format (Bun's bytes), heap statistics' shape.
import v8 from "node:v8";
import type { Case } from "./cases.ts";

export function v8Cases(t: Case) {
  const bytes = (v: unknown) => [...v8.serialize(v)].join(",");
  const values: [string, () => unknown][] = [
    ["primitives", () => [undefined, null, true, false, 0, 1, -5, 2 ** 31, -0, NaN, 1.5, "", "x", "hé", "☃", 2n ** 70n, -3n]],
    ["object", () => ({ a: 1, b: "x", c: [1, 2], d: null, e: true, f: 1.5, g: 2n ** 70n })],
    ["string pool", () => ({ a: { b: 1 }, c: { b: 2 }, d: [, 1], s: "x", t: "x" })],
    ["array extras", () => Object.assign([1, , 3], { extra: "y" })],
    ["references", () => {
      const shared = { n: 1 };
      const cyc: Record<string, unknown> = { shared, again: shared };
      cyc.self = cyc;
      return cyc;
    }],
    ["map set", () => [new Map<unknown, unknown>([[1, "a"], ["k", { v: 2 }]]), new Set([1, "two", 3n])]],
    ["date regexp", () => [new Date(0), /a+b/gi]],
    ["boxed", () => [Object(true), Object(false), Object(2), Object("s"), Object("")]],
    ["boxed bigint", () => Object(5n)],
    ["typed arrays", () => {
      const buf = new ArrayBuffer(8);
      return [new Uint8Array([1, 2]), new Uint16Array([1, 2]), new Float64Array([0.5]), new DataView(buf, 2, 4), new Int32Array(buf, 4, 1), buf, new BigInt64Array([-1n])];
    }],
    ["buffer", () => ({ b: Buffer.from("hi"), n: 1 })],
    ["class instance", () => new (class K {
      x = 1;
    })()],
  ];
  for (const [label, make] of values) {
    t(`v8 serialize ${label}`, () => bytes(make()));
    if (label !== "boxed bigint") t(`v8 roundtrip ${label}`, () => Bun.inspect(v8.deserialize(v8.serialize(make()))).replace(/\s+/g, " "));
  }
  t("v8 roundtrip boxed bigint", () => {
    const back = v8.deserialize(v8.serialize(Object(5n))) as object;
    return [typeof back, back instanceof BigInt, String(back.valueOf())].join();
  });
  t("v8 roundtrip cycle", () => {
    const back = v8.deserialize(v8.serialize(values.find(([l]) => l === "references")![1]())) as Record<string, any>;
    return [back.self === back, back.shared === back.again].join();
  });
  t("v8 buffer is Buffer", () => Buffer.isBuffer((v8.deserialize(v8.serialize({ b: Buffer.from("hi") })) as { b: unknown }).b));
  t("v8 roundtrip error", () => {
    const back = v8.deserialize(v8.serialize(new TypeError("boom"))) as Error;
    return [back.constructor.name, back.message, Object.keys(back).join(), typeof back.stack].join();
  });
  t("v8 serialize type", () => v8.serialize(1).constructor.name);
  for (const [label, v] of [["function", () => 1], ["symbol", Symbol("x")], ["weakmap", new WeakMap()], ["promise", Promise.resolve()]] as const) {
    t(`v8 serialize ${label}`, () => {
      try {
        v8.serialize(v);
        return "no error";
      } catch (e) {
        const err = e as DOMException;
        return [err.name, err.message, err.code, err.constructor.name].join();
      }
    });
  }
  t("v8 deserialize garbage", () => v8.deserialize(Buffer.from([1, 2, 3])));
  t("v8 deserialize string", () => v8.deserialize("x" as never));
  t("v8 heap statistics", () => Object.entries(v8.getHeapStatistics()).map(([k, v]) => `${k}:${typeof v}`).join());
  t("v8 heap spaces", () => v8.getHeapSpaceStatistics().map((s) => `${s.space_name}:${Object.keys(s).length}`).join());
  t("v8 heap code", () => v8.getHeapCodeStatistics());
  t("v8 misc", () => [typeof v8.cachedDataVersionTag(), v8.setFlagsFromString("--x"), v8.isStringOneByteRepresentation("abc"), v8.isStringOneByteRepresentation("☃"), v8.startupSnapshot.isBuildingSnapshot()].join());
  t("v8 Serializer", () => new v8.Serializer());
}
