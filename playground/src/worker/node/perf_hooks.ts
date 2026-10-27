class PerformanceObserver {
  static supportedEntryTypes: string[] = [];
  constructor(_cb?: unknown) {}
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

export default {
  performance,
  PerformanceObserver: globalThis.PerformanceObserver ?? PerformanceObserver,
  PerformanceEntry: globalThis.PerformanceEntry,
  monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, min: 0, max: 0, mean: 0, stddev: 0, percentile: () => 0 }),
  constants: {},
};
