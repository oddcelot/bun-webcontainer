// How a run is confined. The project directory is the only writable place; the user's home is unreadable
// (apart from the Bun binary itself, which may live there); the network stays on, since Bun.serve has to be
// reachable from the runner's preview proxy and `bun install` has to reach the registry.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export type SandboxKind = "bwrap" | "sandbox-exec" | "none";

export function detectSandbox(): SandboxKind {
  if (process.env.RUNBUN_CONNECT_SANDBOX === "none") return "none";
  if (process.platform === "linux" && Bun.which("bwrap")) return "bwrap";
  if (process.platform === "darwin" && Bun.which("sandbox-exec")) return "sandbox-exec";
  return "none";
}

/**
 * The argv that runs `bun <args>` inside `dir` under the given sandbox; `dir` and `extra` are writable. `runnerPort` is
 * the runner's own loopback port: the token is served there (/__connect/info), so on macOS the program can't connect to it.
 */
export function sandboxed(kind: SandboxKind, dir: string, bunArgs: string[], extra: string[] = [], runnerPort?: number): string[] {
  const bun = realpathSync(process.execPath);
  if (kind === "bwrap") {
    // The whole root read-only, then every home hidden behind an empty tmpfs; the project is the only bind
    // that can be written. --unshare-all drops the user, pid, ipc, uts and cgroup namespaces; --share-net
    // gives the network back (see above).
    return [
      "bwrap",
      "--ro-bind", "/", "/",
      "--tmpfs", "/home",
      "--tmpfs", "/root",
      "--tmpfs", "/tmp",
      "--ro-bind", dirname(bun), dirname(bun),
      ...[dir, ...extra].flatMap((d) => ["--bind", d, d]),
      "--dev", "/dev",
      "--proc", "/proc",
      "--unshare-all",
      // The network is shared with the host, loopback included, so a program can still reach the runner's port
      // (and its token): bwrap has no per-port filter. See NOTES.md.
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--chdir", dir,
      bun, ...bunArgs,
    ];
  }
  if (kind === "sandbox-exec") {
    const home = realpathSync(homedir());
    const q = (p: string) => JSON.stringify(p);
    // SBPL: the last matching rule wins.
    const profile = `
(version 1)
(allow default)
(deny file-write*)
(allow file-write* ${[dir, ...extra].map((d) => `(subpath ${q(d)})`).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))
(deny file-read* (subpath ${q(home)}))
(allow file-read* (subpath ${q(dirname(bun))}))
(allow file-read-metadata (literal ${q(home)}) (literal ${q(dirname(home))}))
${runnerPort ? `(deny network-outbound (remote ip "localhost:${runnerPort}"))` : ""}
`;
    return ["sandbox-exec", "-p", profile, bun, ...bunArgs];
  }
  return [bun, ...bunArgs];
}
