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
 * `env` is set inside the sandbox, for Bun alone (bwrap `--setenv`, `/usr/bin/env` under sandbox-exec): the launcher
 * itself runs with the runner's env only. Without a sandbox there's no launcher; `launch` gives it to the spawn instead.
 */
export function sandboxed(kind: SandboxKind, dir: string, bunArgs: string[], extra: string[] = [], runnerPort?: number, env: Record<string, string> = {}): string[] {
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
      ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
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
; \`(allow default)\` would let a program ask LaunchServices to start an app outside the sandbox (\`open x.command\`
; opens Terminal): no open/osascript, and no talking to the services that launch apps or send Apple Events.
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name-prefix "com.apple.lsd."))
${runnerPort ? `(deny network-outbound (remote ip "localhost:${runnerPort}"))` : ""}
`;
    // env(1) under the profile, so the variables exist only once sandbox-exec has applied it (the profile lets a run
    // exec anything but open and osascript).
    const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return ["sandbox-exec", "-p", profile, ...(pairs.length ? ["/usr/bin/env", ...pairs] : []), bun, ...bunArgs];
  }
  return [bun, ...bunArgs];
}

/**
 * How to start a run: its argv (`sandboxed`) and the launcher's env. Under a sandbox that's the runner's env alone,
 * and `projectEnv` is set only inside it; without one it's the program's own env, the runner's names winning.
 */
export function launch(
  kind: SandboxKind,
  dir: string,
  bunArgs: string[],
  extra: string[],
  runnerPort: number | undefined,
  runnerEnv: Record<string, string>,
  projectEnv: Record<string, string>,
): { argv: string[]; env: Record<string, string> } {
  if (kind === "none") return { argv: sandboxed(kind, dir, bunArgs, extra, runnerPort), env: { ...projectEnv, ...runnerEnv } };
  return { argv: sandboxed(kind, dir, bunArgs, extra, runnerPort, projectEnv), env: runnerEnv };
}
