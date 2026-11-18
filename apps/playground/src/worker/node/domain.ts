// node:domain as Bun has it (bun/src/js/node/domain.ts): a domain is an EventEmitter whose `run`, `bind` and
// `intercept` turn a synchronous throw into its "error" event; `add`d emitters forward their errors to it. Unlike
// Node, nothing asynchronous is caught (in Bun neither).
import EventEmitter from "events";
import process from "./process";

type Fn = (...args: any[]) => any;
type Domain = EventEmitter & Record<string, Fn>;

const stack: Domain[] = [];

const domain = {
  _stack: stack,
  active: null as Domain | null,
  create: createDomain,
  createDomain,
};

function setActive(d: Domain | null) {
  domain.active = d;
  (process as { domain?: unknown }).domain = d;
}

function createDomain(): Domain {
  const d = new EventEmitter() as Domain;
  function emitError(this: unknown, e: unknown) {
    e ||= Object.assign(new Error("Unhandled error."), { code: "ERR_UNHANDLED_ERROR" });
    if (typeof e === "object") {
      Object.assign(e as object, { domainEmitter: this });
      Object.defineProperty(e, "domain", { configurable: true, enumerable: false, value: d, writable: true });
      (e as { domainThrown?: boolean }).domainThrown = false;
    }
    d.emit("error", e);
  }
  d.add = (emitter: EventEmitter) => void emitter.on("error", emitError);
  d.remove = (emitter: EventEmitter) => void emitter.removeListener("error", emitError);
  d.bind = (fn: Fn) =>
    function (...args: unknown[]) {
      try {
        fn.apply(null, args);
      } catch (err) {
        emitError(err);
      }
    };
  d.intercept = (fn: Fn) =>
    function (err: unknown, ...args: unknown[]) {
      if (err) return emitError(err);
      try {
        fn.apply(null, args);
      } catch (e) {
        emitError(e);
      }
    };
  d.run = function (this: Domain, fn: Fn, ...args: unknown[]) {
    this.enter();
    try {
      return fn.apply(this, args);
    } catch (err) {
      emitError(err);
    } finally {
      this.exit();
    }
  };
  d.dispose = function (this: Domain) {
    this.removeAllListeners();
    return this;
  };
  d.enter = function (this: Domain) {
    stack.push(this);
    setActive(this);
    return this;
  };
  d.exit = function (this: Domain) {
    const index = stack.lastIndexOf(this);
    if (index === -1) return this;
    stack.splice(index, stack.length);
    setActive(stack.length ? stack[stack.length - 1] : null);
    return this;
  };
  return d;
}

export default domain;
