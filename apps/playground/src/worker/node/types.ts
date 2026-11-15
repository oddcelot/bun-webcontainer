// node:util/types. Brand checks (a builtin method that throws on anything else) where JS has one, so subclasses
// and a spoofed Symbol.toStringTag don't fool them; otherwise the internal [[Class]] via Object.prototype.toString.
import { isProxy } from "../proxies";

const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);
const brand = (fn: Function) => (v: unknown) => {
  if (typeof v !== "object" || v === null) return false;
  try {
    fn.call(v);
    return true;
  } catch {
    return false;
  }
};
const getter = (proto: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(proto, key)!.get!;
const typedArrayName = getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
const typedArrayIs = (name: string) => (v: unknown) => ArrayBuffer.isView(v) && typedArrayName.call(v) === name;
const isArrayBuffer = brand(getter(ArrayBuffer.prototype, "byteLength"));
const isSharedArrayBuffer = typeof SharedArrayBuffer === "undefined" ? () => false : brand(getter(SharedArrayBuffer.prototype, "byteLength"));
const isNumberObject = brand(Number.prototype.valueOf);
const isStringObject = brand(String.prototype.valueOf);
const isBooleanObject = brand(Boolean.prototype.valueOf);
const isBigIntObject = brand(BigInt.prototype.valueOf);
const isSymbolObject = brand(Symbol.prototype.valueOf);
const mapIteratorProto = Object.getPrototypeOf(new Map().entries());
const setIteratorProto = Object.getPrototypeOf(new Set().values());
const isFunctionKind = (...kinds: string[]) => (v: unknown) => typeof v === "function" && kinds.includes(tag(v));

export const types = {
  isPromise: (v: unknown) => v instanceof Promise,
  isRegExp: brand(getter(RegExp.prototype, "source")),
  isDate: brand(Date.prototype.getTime),
  isNativeError: (v: unknown) => {
    const e = Error as unknown as { isError?: (v: unknown) => boolean };
    return typeof e.isError === "function" ? e.isError(v) : v instanceof Error;
  },
  isMap: brand(Map.prototype.has),
  isSet: brand(Set.prototype.has),
  isWeakMap: brand(WeakMap.prototype.has),
  isWeakSet: brand(WeakSet.prototype.has),
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && typedArrayName.call(v) !== undefined,
  isUint8Array: typedArrayIs("Uint8Array"),
  isArrayBuffer,
  isSharedArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => isArrayBuffer(v) || isSharedArrayBuffer(v),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isDataView: (v: unknown) => ArrayBuffer.isView(v) && typedArrayName.call(v) === undefined,
  isAsyncFunction: isFunctionKind("AsyncFunction", "AsyncGeneratorFunction"),
  isGeneratorFunction: isFunctionKind("GeneratorFunction", "AsyncGeneratorFunction"),
  isGeneratorObject: (v: unknown) => tag(v) === "Generator",
  isProxy,
  isBoxedPrimitive: (v: unknown) => isNumberObject(v) || isStringObject(v) || isBooleanObject(v) || isBigIntObject(v) || isSymbolObject(v),
  isNumberObject,
  isStringObject,
  isBooleanObject,
  isBigIntObject,
  isSymbolObject,
  isMapIterator: (v: unknown) => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === mapIteratorProto,
  isSetIterator: (v: unknown) => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === setIteratorProto,
  isModuleNamespaceObject: (v: unknown) => tag(v) === "Module",
  isExternal: () => false,
  isArgumentsObject: (v: unknown) => tag(v) === "Arguments",
  isBigInt64Array: typedArrayIs("BigInt64Array"),
  isBigUint64Array: typedArrayIs("BigUint64Array"),
  isFloat32Array: typedArrayIs("Float32Array"),
  isFloat64Array: typedArrayIs("Float64Array"),
  isInt8Array: typedArrayIs("Int8Array"),
  isInt16Array: typedArrayIs("Int16Array"),
  isInt32Array: typedArrayIs("Int32Array"),
  isUint8ClampedArray: typedArrayIs("Uint8ClampedArray"),
  isUint16Array: typedArrayIs("Uint16Array"),
  isUint32Array: typedArrayIs("Uint32Array"),
};
