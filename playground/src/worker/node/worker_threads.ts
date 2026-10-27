import EventEmitter from "events";

class Worker extends EventEmitter {
  constructor() {
    super();
    throw new Error("node:worker_threads.Worker is not supported in the playground");
  }
}

export default {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  resourceLimits: {},
  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  receiveMessageOnPort: () => undefined,
  markAsUntransferable() {},
  setEnvironmentData() {},
  getEnvironmentData: () => undefined,
};
