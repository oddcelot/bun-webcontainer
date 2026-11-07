// Messages over the runner's WebSocket, JSON, one per frame.

export type ClientMessage =
  | { t: "run"; id: string; files: Record<string, string>; entry: string; args?: string[] }
  | { t: "stdin"; id: string; data: string }
  | { t: "kill"; id: string };

export type ServerMessage =
  | { t: "hello"; bun: string; platform: string; sandbox: string }
  | { t: "started"; id: string; preview: string }
  | { t: "out"; id: string; fd: 1 | 2; data: string }
  | { t: "exit"; id: string; code: number | null; signal: string | null }
  | { t: "error"; id?: string; message: string };
