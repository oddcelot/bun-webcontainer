import { createContext } from "solid-js";
import type { createConsole } from "../console";
import type { LogFn } from "../runner";
import type { Check } from "../support";
import type { VFS } from "../vfs";
import type { Previews } from "./previews";
import type { Session } from "./session";
import type { Workspace } from "./workspace";

/** What the UI needs from main.ts, which still owns the engine (VFS, runner, tabs, file tree). */
export type App = {
  session: Session;
  /** What the browser supports; `session.canRun` is false when any check fails. */
  support: Check[];
  workspace: Workspace;
  previews: Previews;
  /** The console's terminal; the Console pane attaches it. */
  terminal: ReturnType<typeof createConsole>;
  clearConsole(): void;
  vfs: VFS;
  log: LogFn;
  run(): void;
  /** Stops the running server, if any. */
  stop(): void;
  install(): void;
  /** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
  openProject(value: string): void;
  /** Creates an empty file and opens it. */
  newFile(path: string): Promise<void>;
  openFolder(files: File[]): void;
  /** Opens a folder on disk and saves edits to it (only where `showDirectoryPicker` exists). */
  openDirectory(): void;
  /** Opens the last folder from disk again, asking for access. */
  reopenFolder(): void;
  /** Opens a zip's files like a folder. */
  openZip(file: File): void;
  /** The `?repo=` the page was opened with, as the repo prompt's default. */
  repoParam: string;
  /** What an embed has turned on (embed/config.ts); absent on the full playground, which has everything. */
  features?: { has(name: "types" | "format" | "tabs" | "autosave" | "edit"): boolean };
};

export const AppContext = createContext<App>();
