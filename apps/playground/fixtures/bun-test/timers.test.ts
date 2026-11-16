import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";

afterEach(() => jest.useRealTimers());

describe("fake timers", () => {
  test("timeouts and intervals fire in order of their time", () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    setTimeout(() => calls.push("t100"), 100);
    setTimeout(() => calls.push("t200"), 200);
    const iv = setInterval(() => calls.push("iv50"), 50);
    expect(jest.getTimerCount()).toBe(3);
    jest.advanceTimersByTime(99);
    expect(calls).toEqual(["iv50"]);
    jest.advanceTimersByTime(1);
    expect(calls).toEqual(["iv50", "t100", "iv50"]);
    jest.advanceTimersByTime(100);
    expect(calls.join()).toBe("iv50,t100,iv50,iv50,t200,iv50");
    clearInterval(iv);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("Date follows the fake clock", () => {
    const real = Date.now();
    jest.useFakeTimers();
    const d0 = Date.now();
    expect(Math.abs(d0 - real)).toBeLessThan(1000);
    expect(jest.now()).toBe(d0);
    jest.advanceTimersByTime(1000);
    expect(Date.now() - d0).toBe(1000);
    expect(new Date().getTime() - d0).toBe(1000);
    jest.useFakeTimers({ now: 1000 });
    expect(new Date().toISOString()).toBe("1970-01-01T00:00:01.000Z");
    jest.useRealTimers();
    expect(Date.now()).toBeGreaterThan(1.7e12);
  });
  test("runOnlyPendingTimers leaves what the callbacks schedule", () => {
    jest.useFakeTimers();
    const c: string[] = [];
    setTimeout(() => {
      c.push("a");
      setTimeout(() => c.push("b"), 10);
    }, 10);
    jest.runOnlyPendingTimers();
    expect(c).toEqual(["a"]);
    expect(jest.getTimerCount()).toBe(1);
    jest.runAllTimers();
    expect(c).toEqual(["a", "b"]);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("clearAllTimers, ids, arguments", () => {
    jest.useFakeTimers();
    const c: unknown[] = [];
    const t = setTimeout((a: number, b: number) => c.push(a + b), 10, 1, 2);
    expect(typeof t).toBe("object");
    expect(+t > 0).toBe(true);
    const u = setTimeout(() => c.push("never"), 20);
    clearTimeout(u);
    setTimeout(() => c.push("cleared"), 5);
    jest.clearAllTimers();
    jest.runAllTimers();
    expect(c).toEqual([]);
    setTimeout((a: number, b: number) => c.push(a + b), 10, 1, 2);
    jest.advanceTimersByTime(10);
    expect(c).toEqual([3]);
  });
  test("advanceTimersToNextTimer", () => {
    jest.useFakeTimers();
    const c: string[] = [];
    setTimeout(() => c.push("a"), 30);
    setTimeout(() => c.push("b"), 10);
    jest.advanceTimersToNextTimer();
    expect(c).toEqual(["b"]);
    jest.advanceTimersToNextTimer();
    expect(c).toEqual(["b", "a"]);
  });
  test("promises settle once the timers are advanced", async () => {
    jest.useFakeTimers();
    let done = false;
    const p = new Promise<void>((r) =>
      setTimeout(() => {
        done = true;
        r();
      }, 1000),
    );
    jest.advanceTimersByTime(1000);
    await p;
    expect(done).toBe(true);
  });
  test("Bun.sleep runs on the fake clock", async () => {
    jest.useFakeTimers();
    let done = false;
    void Bun.sleep(100).then(() => (done = true));
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    expect(done).toBe(false);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });
  test("the controls need fake timers", () => {
    expect(() => jest.advanceTimersByTime(5)).toThrow("Fake timers are not active. Call useFakeTimers() first.");
    expect(() => jest.getTimerCount()).toThrow("Fake timers are not active");
    expect(jest.isFakeTimers()).toBe(false);
    jest.useFakeTimers();
    expect(jest.isFakeTimers()).toBe(true);
    jest.useFakeTimers();
    jest.useRealTimers();
    jest.useRealTimers();
    expect(jest.isFakeTimers()).toBe(false);
  });
  test("an error thrown by a callback reaches the caller", () => {
    jest.useFakeTimers();
    setTimeout(() => {
      throw new Error("from a timer");
    }, 1);
    expect(() => jest.advanceTimersByTime(1)).toThrow("from a timer");
  });
});

describe("setSystemTime", () => {
  test("freezes Date without faking timers", async () => {
    setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    expect(new Date().toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(Date.now()).toBe(1577836800000);
    await Bun.sleep(20);
    expect(Date.now()).toBe(1577836800000);
    expect(jest.isFakeTimers()).toBe(false);
    jest.setSystemTime(86400000);
    expect(new Date().toISOString()).toBe("1970-01-02T00:00:00.000Z");
    expect(new Date(2000, 0, 1).getFullYear()).toBe(2000);
    setSystemTime();
    expect(Date.now()).toBeGreaterThan(1.7e12);
  });
  test("with fake timers the clock moves from it", () => {
    jest.useFakeTimers();
    jest.setSystemTime(5000);
    expect(Date.now()).toBe(5000);
    jest.advanceTimersByTime(10);
    expect(Date.now()).toBe(5010);
  });
  test("a Date made from a value is the real thing", () => {
    jest.useFakeTimers({ now: 0 });
    expect(new Date(2024, 0, 15) instanceof Date).toBe(true);
    expect(new Date("2024-01-15T00:00:00Z").getTime()).toBe(1705276800000);
    expect(typeof Date()).toBe("string");
  });
});
