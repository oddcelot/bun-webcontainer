// Messages over the runner's WebSocket (/__connect/ws), JSON, one per frame.

/** A file's contents: text, or bytes as base64. */
export type FileData = string | { b64: string };

export type ClientMessage =
  | {
      t: "run";
      id: string;
      /** Runs of one project share a directory, so node_modules survives between runs. */
      project?: string;
      /** The project's files, relative paths. Files of the project's previous run that aren't here are deleted. */
      files: Record<string, FileData>;
      entry: string;
      args?: string[];
      /** `bun install` before the run (default: when there is a package.json). */
      install?: boolean;
      /** `bun test <files>` instead of `bun run <entry>`. An empty entry and no `test` only installs. */
      test?: string[];
    }
  | { t: "stdin"; id: string; data: string }
  | { t: "kill"; id: string };

export type ServerMessage =
  | { t: "hello"; bun: string; platform: string; sandbox: string }
  | { t: "started"; id: string; preview: string }
  | { t: "out"; id: string; fd: 1 | 2; data: string }
  /** phase: which step a line or exit belongs to. */
  | { t: "phase"; id: string; phase: "install" | "run" }
  /** The program accepts connections on its port (Bun.serve is up): previews can go to it. */
  | { t: "listening"; id: string }
  | { t: "exit"; id: string; code: number | null; signal: string | null }
  | { t: "error"; id?: string; message: string };

/** GET /__connect/info, same-origin only: what a page served by the runner needs to connect. */
export interface ConnectInfo {
  ws: string;
  token: string;
  bun: string;
  sandbox: string;
}
