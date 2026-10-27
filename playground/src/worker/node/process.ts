import EventEmitter from "events";

type Sink = (level: "log" | "error", text: string) => void;

let sink: Sink = (level, text) => console[level](text);
/** The worker routes stdout/stderr to its console pane. */
export function setStdio(fn: Sink) {
  sink = fn;
}

const dec = new TextDecoder();

function stdio(fd: number, level: "log" | "error") {
  return Object.assign(new EventEmitter(), {
    fd,
    isTTY: false,
    writable: true,
    columns: 80,
    rows: 24,
    write(chunk: string | Uint8Array, enc?: unknown, cb?: unknown) {
      const text = typeof chunk === "string" ? chunk : dec.decode(chunk);
      sink(level, text.endsWith("\n") ? text.slice(0, -1) : text);
      if (typeof enc === "function") queueMicrotask(enc as () => void);
      else if (typeof cb === "function") queueMicrotask(cb as () => void);
      return true;
    },
    end() {},
    cork() {},
    uncork() {},
    setEncoding() {},
    getColorDepth: () => 1,
    hasColors: () => false,
    getWindowSize: () => [80, 24],
    ref() {},
    unref() {},
  });
}

const stdin = Object.assign(new EventEmitter(), {
  fd: 0,
  isTTY: false,
  readable: true,
  setRawMode() {},
  setEncoding() {},
  resume() {},
  pause() {},
  ref() {},
  unref() {},
});

/** Bun.env and process.env are the same object in Bun. */
export const env: Record<string, string> = { NODE_ENV: "development" };

let cwd = "/";

const hrtime = Object.assign(
  (prev?: [number, number]): [number, number] => {
    const t = performance.now();
    let s = Math.floor(t / 1000);
    let n = Math.floor((t % 1000) * 1e6);
    if (prev) {
      s -= prev[0];
      n -= prev[1];
      if (n < 0) (s--, (n += 1e9));
    }
    return [s, n];
  },
  { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
);

const memory = () => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return { rss: m?.totalJSHeapSize ?? 0, heapTotal: m?.totalJSHeapSize ?? 0, heapUsed: m?.usedJSHeapSize ?? 0, external: 0, arrayBuffers: 0 };
};

const process: Record<string, any> = Object.assign(new EventEmitter(), {
  env,
  argv: ["bun"],
  execArgv: [] as string[],
  execPath: "/usr/local/bin/bun",
  title: "bun",
  pid: 1,
  ppid: 0,
  platform: "linux",
  arch: "x64",
  version: "v24.3.0",
  versions: { node: "24.3.0", bun: "1.4.4-browser", v8: "13.6.233.10-node.18", uv: "1.51.0", modules: "137" },
  release: { name: "node", lts: "Krypton" },
  features: {},
  config: { variables: {} },
  exitCode: undefined as number | undefined,
  stdin,
  stdout: stdio(1, "log"),
  stderr: stdio(2, "error"),
  cwd: () => cwd,
  chdir(dir: string) {
    cwd = dir.startsWith("/") ? dir : `${cwd === "/" ? "" : cwd}/${dir}`;
  },
  hrtime,
  uptime: () => performance.now() / 1000,
  memoryUsage: Object.assign(memory, { rss: () => memory().rss }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  umask: () => 0o22,
  getuid: () => 1000,
  geteuid: () => 1000,
  getgid: () => 1000,
  getegid: () => 1000,
  emitWarning(warning: string | Error) {
    process.stderr.write(`(bun) ${typeof warning === "string" ? "Warning: " + warning : `${warning.name}: ${warning.message}`}\n`);
  },
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  binding() {
    throw new Error("process.binding is not supported in the playground");
  },
  kill() {
    throw new Error("process.kill is not supported in the playground");
  },
  exit(code = 0) {
    throw new Error(`process.exit(${code}) is not supported in the playground`);
  },
});

export default process;
