import { expect, test } from "bun:test";
import { classify, findSocketInode, ipKey, parseProcNet, parseStat, peerVerdict, procAddrKey, readProcs, refuse, type FsLike } from "./src/peer.ts";

// Real-format lines: 127.0.0.1:7357 is 0100007F:1CBD; a client at 127.0.0.1:41234 is 0100007F:A112.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1CBD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A112 0100007F:1CBD 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:1CBD 0100007F:A112 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:A113 0100007F:1CBD 06 00000000:00000000 00:00000000 00000000     0        0 0 3 0000000000000000
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:C000 0000000000000000FFFF00000100007F:1CBD 01 00000000:00000000 00:00000000 00000000  1000        0 55555 1 0000000000000000 20 4 30 10 -1
`;

test("addresses", () => {
  expect(procAddrKey("0100007F")).toBe(ipKey("127.0.0.1")!);
  expect(procAddrKey("00000000000000000000000001000000")).toBe(ipKey("::1")!);
  expect(procAddrKey("0000000000000000FFFF00000100007F")).toBe(ipKey("127.0.0.1")!);
  expect(ipKey("::ffff:127.0.0.1")).toBe(ipKey("127.0.0.1")!);
  expect(ipKey("fe80::1")).toBe("fe800000000000000000000000000001");
  expect(ipKey("nonsense")).toBeUndefined();
  expect(ipKey("1:2:3")).toBeUndefined();
});

test("parse /proc/net/tcp and tcp6", () => {
  const rows = parseProcNet(TCP);
  expect(rows.length).toBe(4);
  expect(rows[1]).toMatchObject({ localPort: 41234, remotePort: 7357, state: "01", inode: 22222 });
  expect(parseProcNet(TCP6).length).toBe(2);
  expect(parseProcNet("garbage\n\n")).toEqual([]);
});

test("the client's socket, not the runner's end of it", () => {
  const server = { address: "127.0.0.1", port: 7357 };
  const rows = parseProcNet(TCP);
  expect(findSocketInode(rows, { address: "127.0.0.1", port: 41234 }, server)).toBe(22222);
  expect(findSocketInode(rows, { address: "127.0.0.1", port: 41235 }, server)).toBeUndefined();
  // not established
  expect(findSocketInode(rows, { address: "127.0.0.1", port: 0xa113 }, server)).toBeUndefined();
  // an IPv4-mapped row in tcp6
  expect(findSocketInode(parseProcNet(TCP6), { address: "127.0.0.1", port: 0xc000 }, server)).toBe(55555);
});

test("parseStat copes with odd command names", () => {
  expect(parseStat("123 (bun) S 100 123 123 0 -1 4194560")).toEqual({ ppid: 100, sid: 123 });
  expect(parseStat("123 (a) b) c) S 100 7 8 0 -1")).toEqual({ ppid: 100, sid: 8 });
  expect(parseStat("junk")).toBeUndefined();
});

// A fake /proc. pid 10 is the bwrap process of a run (its own session); 11 its child; 12 a grandchild holding the
// client socket; 20 a browser's network process; 30 a process of another user (unreadable fds).
type Procs = Record<number, { ppid: number; sid: number; fds?: string[] | null }>;
function fakeFs(procs: Procs, net = TCP): FsLike {
  const files: Record<string, string> = { "/proc/net/tcp": net, "/proc/net/tcp6": TCP6 };
  return {
    readFile(p) {
      if (p in files) return files[p]!;
      const m = p.match(/^\/proc\/(\d+)\/stat$/);
      const pr = m && procs[Number(m[1])];
      if (pr) return `${m[1]} (x y) S ${pr.ppid} ${pr.sid} ${pr.sid} 0 -1`;
      throw new Error("ENOENT " + p);
    },
    readdir(p) {
      if (p === "/proc") return [...Object.keys(procs), "net", "self"];
      const m = p.match(/^\/proc\/(\d+)\/fd$/);
      const fds = m && procs[Number(m[1])]?.fds;
      if (!fds) throw new Error("EACCES " + p);
      return fds.map((_, i) => String(i));
    },
    readlink(p) {
      const m = p.match(/^\/proc\/(\d+)\/fd\/(\d+)$/)!;
      return procs[Number(m[1])]!.fds![Number(m[2])]!;
    },
  };
}
const client = { address: "127.0.0.1", port: 41234 };
const server = { address: "127.0.0.1", port: 7357 };
const base: Procs = {
  1: { ppid: 0, sid: 1, fds: [] },
  5: { ppid: 1, sid: 5, fds: ["socket:[33333]", "/dev/null"] }, // the runner itself
  10: { ppid: 5, sid: 10, fds: ["pipe:[1]"] },
  11: { ppid: 10, sid: 10, fds: [] },
  20: { ppid: 1, sid: 20, fds: ["socket:[999]"] },
  30: { ppid: 1, sid: 30, fds: null },
};

test("a run's grandchild holding the socket is refused", () => {
  const fs = fakeFs({ ...base, 12: { ppid: 11, sid: 10, fds: ["socket:[22222]"] } });
  expect(peerVerdict(fs, client, server, [10])).toBe("run");
  expect(refuse("run")).toBe(true);
});

test("a reparented process still counts through the root's session", () => {
  const fs = fakeFs({ ...base, 12: { ppid: 1, sid: 10, fds: ["socket:[22222]"] } });
  expect(peerVerdict(fs, client, server, [10])).toBe("run");
});

test("a browser process outside every run is allowed", () => {
  const fs = fakeFs({ ...base, 20: { ppid: 1, sid: 20, fds: ["socket:[22222]"] } });
  expect(peerVerdict(fs, client, server, [10])).toBe("other");
  expect(refuse("other")).toBe(false);
});

test("an owner nobody readable holds is unknown: refused when failing closed", () => {
  const fs = fakeFs(base); // 30's fds are unreadable, nobody readable has 22222
  expect(peerVerdict(fs, client, server, [10])).toBe("unknown");
  expect(refuse("unknown")).toBe(true);
  expect(refuse("unknown", false)).toBe(false);
});

test("a connection missing from /proc/net/tcp is unknown", () => {
  expect(peerVerdict(fakeFs(base, ""), client, server, [10])).toBe("unknown");
});

test("classify and readProcs", () => {
  const procs = readProcs(fakeFs({ ...base, 12: { ppid: 11, sid: 10, fds: ["socket:[22222]"] } }));
  expect(procs.find((p) => p.pid === 30)!.inodes).toBeUndefined();
  expect(procs.find((p) => p.pid === 12)!.inodes).toEqual(new Set([22222]));
  expect(classify(22222, procs, [10])).toBe("run");
  expect(classify(22222, procs, [20])).toBe("other"); // 12 isn't under 20
  expect(classify(1, procs, [10])).toBe("unknown");
});
