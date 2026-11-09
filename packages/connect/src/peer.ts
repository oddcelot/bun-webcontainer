// Linux only: who is on the other end of a loopback connection to the runner? bwrap shares the host network, so a
// sandboxed program can connect to the runner and fetch its token from /__connect/info (macOS closes that with an SBPL
// rule; bwrap has no per-port filter). Instead the runner finds the client's socket in /proc/net/tcp, then looks for
// that socket's inode among the file descriptors of the processes of its live runs. The functions here are pure (file
// contents or a fake `FsLike` go in), so peer.test.ts runs them anywhere; server.ts passes the real /proc.

/** The three reads this module does. */
export interface FsLike {
  readFile(path: string): string;
  readdir(path: string): string[];
  readlink(path: string): string;
}

export interface Endpoint {
  address: string;
  port: number;
}

export interface NetRow {
  local: string;
  localPort: number;
  remote: string;
  remotePort: number;
  /** Hex TCP state, "01" = ESTABLISHED. */
  state: string;
  inode: number;
}

export interface ProcView {
  pid: number;
  ppid: number;
  /** Session id: bwrap's `--new-session` makes the run's root process its own session leader. */
  sid: number;
  /** Socket inodes among its fds; undefined when /proc/<pid>/fd can't be read (other user, not dumpable, ...). */
  inodes: Set<number> | undefined;
}

/** "run": a socket of a run's processes. "other": found in a readable process outside every run. "unknown": no readable process has it. */
export type Verdict = "run" | "other" | "unknown";

/**
 * What to do with a peer whose owner can't be found. true (fail closed): refuse it. A program can make its own
 * /proc/<pid>/fd unreadable (prctl PR_SET_DUMPABLE 0) and so hide from the walk; failing open would let exactly that
 * through. The cost: a browser whose network process we can't read is refused too. See NOTES.md.
 */
export const FAIL_CLOSED = true;

const v4hex = (s: string) => {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return undefined;
  return m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
};

/** Any IP as 32 hex digits (IPv4 as ::ffff:a.b.c.d), so "127.0.0.1" and "::ffff:127.0.0.1" compare equal. */
export function ipKey(ip: string): string | undefined {
  const plain = v4hex(ip);
  if (plain) return "0".repeat(20) + "ffff" + plain;
  const halves = ip.split("::");
  if (halves.length > 2) return undefined;
  const groups = (s: string) => {
    const g = s ? s.split(":") : [];
    const last = g.at(-1);
    if (last?.includes(".")) {
      const q = v4hex(last);
      if (!q) return ["x"];
      g.splice(-1, 1, q.slice(0, 4), q.slice(4));
    }
    return g;
  };
  let g = groups(halves[0]!);
  if (halves.length === 2) {
    const tail = groups(halves[1]!);
    const fill = 8 - g.length - tail.length;
    if (fill < 1) return undefined;
    g = [...g, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (g.length !== 8 || !g.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) return undefined;
  return g.map((x) => x.toLowerCase().padStart(4, "0")).join("");
}

/** The address column of /proc/net/tcp(6): each 32-bit word is printed in host (little-endian) byte order. */
export function procAddrKey(hex: string): string | undefined {
  const le = (w: string) => w.match(/../g)!.reverse().join("");
  if (/^[0-9a-f]{8}$/i.test(hex)) return "0".repeat(20) + "ffff" + le(hex).toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(hex)) return hex.match(/.{8}/g)!.map(le).join("").toLowerCase();
  return undefined;
}

/** The rows of /proc/net/tcp or tcp6 (header and malformed lines skipped). */
export function parseProcNet(text: string): NetRow[] {
  const rows: NetRow[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[0] === "sl") continue;
    const [la, lp] = f[1]!.split(":");
    const [ra, rp] = f[2]!.split(":");
    const local = la && procAddrKey(la);
    const remote = ra && procAddrKey(ra);
    const inode = Number(f[9]);
    if (!local || !remote || !lp || !rp || !Number.isInteger(inode)) continue;
    rows.push({ local, localPort: parseInt(lp, 16), remote, remotePort: parseInt(rp, 16), state: f[3]!, inode });
  }
  return rows;
}

/** The inode of the client's own end of an established connection to `server`: the row that reads client -> server. */
export function findSocketInode(rows: NetRow[], client: Endpoint, server: Endpoint): number | undefined {
  const c = ipKey(client.address);
  const s = ipKey(server.address);
  if (!c || !s) return undefined;
  const row = rows.find(
    (r) => r.state === "01" && r.local === c && r.localPort === client.port && r.remote === s && r.remotePort === server.port,
  );
  return row && row.inode !== 0 ? row.inode : undefined;
}

/** ppid and session id from /proc/<pid>/stat. The command name is in parentheses and may hold anything, so split after the last ")". */
export function parseStat(text: string): { ppid: number; sid: number } | undefined {
  const f = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/); // state ppid pgrp session ...
  const ppid = Number(f[1]);
  const sid = Number(f[3]);
  return Number.isInteger(ppid) && Number.isInteger(sid) ? { ppid, sid } : undefined;
}

/** Every process /proc shows, with the socket inodes it holds. */
export function readProcs(fs: FsLike): ProcView[] {
  const out: ProcView[] = [];
  let names: string[];
  try {
    names = fs.readdir("/proc");
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let st: ReturnType<typeof parseStat>;
    try {
      st = parseStat(fs.readFile(`/proc/${name}/stat`));
    } catch {}
    if (!st) continue;
    let inodes: Set<number> | undefined;
    try {
      const found = new Set<number>();
      for (const fd of fs.readdir(`/proc/${name}/fd`)) {
        try {
          const m = fs.readlink(`/proc/${name}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
          if (m) found.add(Number(m[1]));
        } catch {} // an fd closed meanwhile
      }
      inodes = found;
    } catch {}
    out.push({ pid: Number(name), ppid: st.ppid, sid: st.sid, inodes });
  }
  return out;
}

/** The pids in the runs' trees: each root (the bwrap process), its descendants, and anything in a root's session. */
export function runPids(procs: ProcView[], roots: number[]): Set<number> {
  const set = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs)
      if (!set.has(p.pid) && (set.has(p.ppid) || set.has(p.sid))) {
        set.add(p.pid);
        grew = true;
      }
  }
  return set;
}

/** Whose socket is `inode`? */
export function classify(inode: number, procs: ProcView[], roots: number[]): Verdict {
  const inRun = runPids(procs, roots);
  let other = false;
  for (const p of procs) {
    if (!p.inodes?.has(inode)) continue;
    if (inRun.has(p.pid)) return "run";
    other = true;
  }
  return other ? "other" : "unknown";
}

/** The rows of /proc/net/tcp and tcp6 together; a missing file (no IPv6) adds nothing. */
export function readNetRows(fs: FsLike): NetRow[] {
  const rows: NetRow[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"])
    try {
      rows.push(...parseProcNet(fs.readFile(f)));
    } catch {}
  return rows;
}

/** The whole check for one connection: the client's socket in /proc/net/tcp(6), then its owner. No inode found is "unknown". */
export function peerVerdict(fs: FsLike, client: Endpoint, server: Endpoint, roots: number[]): Verdict {
  const rows = readNetRows(fs);
  const inode = findSocketInode(rows, client, server);
  if (inode === undefined) return "unknown";
  return classify(inode, readProcs(fs), roots);
}

/** Refuse this verdict? */
export function refuse(v: Verdict, failClosed = FAIL_CLOSED): boolean {
  return v === "run" || (v === "unknown" && failClosed);
}

/** The TCP ports the processes in `root`'s tree listen on (state 0A), from /proc: what `lsof -sTCP:LISTEN` tells on macOS. */
export function listeningPorts(rows: NetRow[], procs: ProcView[], root: number): number[] {
  const tree = runPids(procs, [root]);
  const held = new Set<number>();
  for (const p of procs) if (tree.has(p.pid)) for (const i of p.inodes ?? []) held.add(i);
  return [...new Set(rows.filter((r) => r.state === "0A" && held.has(r.inode)).map((r) => r.localPort))];
}
