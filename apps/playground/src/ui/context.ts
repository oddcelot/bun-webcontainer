import { createContext } from "solid-js";
import type { createConsole } from "../console";
import type { Playground } from "../boot";
import type { LogFn } from "../runner";
import type { Check } from "../support";
import type { VFS } from "@runbun/vfs";
import type { Git } from "../git/store";
import type { Previews } from "./previews";
import type { Session } from "./session";
import type { Workspace } from "./workspace";

/** What the UI needs from main.ts, which still owns the engine (VFS, runner, tabs, file tree). */
export type App = {
  session: Session;
  /** What the browser supports; `session.canRun` is false when any check fails. */
  support: Check[];
  /** Where runs go: the browser or native Bun on this machine (the full playground only; boot.ts). */
  runtime?: Playground["runtime"];
  workspace: Workspace;
  previews: Previews;
  /** The console's terminal; the Console pane attaches it. */
  terminal: ReturnType<typeof createConsole>;
  clearConsole(): void;
  vfs: VFS;
  /** The Git panel's state: the explorer's second view, and the tree's status badges. */
  git: Git;
  log: LogFn;
  run(): void;
  /** Stops the running server, if any. */
  stop(): void;
  /** Shows the server on `port` in the preview (one of `session.ports()`) and reloads it. */
  choosePort(port: number): void;
  install(): void;
  /** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
  openProject(value: string): void;
  /** Creates an empty file and opens it. */
  newFile(path: string): Promise<void>;
  /** Moves a file or folder (its tabs follow); resolves to its undo. */
  renamePath(from: string, to: string): Promise<() => Promise<void>>;
  /** Deletes a file or folder (its tabs close); resolves to its undo. */
  removePath(path: string): Promise<() => Promise<void>>;
  openFolder(files: File[]): void;
  /** Opens a folder on disk and saves edits to it (only where `showDirectoryPicker` exists). */
  openDirectory(): void;
  /** Opens the last folder from disk again, asking for access. */
  reopenFolder(): void;
  /** Opens a zip's files like a folder. */
  openZip(file: File): void;
  /** Saved projects and caches, for the Storage dialog (the full playground only). */
  storage?: {
    /** This page's saved project id (null: not saved), once known. */
    current(): Promise<string | null>;
    /** Deletes a saved project; this page's own reloads from its source. */
    remove(id: string): Promise<void>;
    /** Deletes every saved project but those open in other tabs, and the caches; then reloads. */
    clearAll(): Promise<void>;
  };
  /** The `?repo=` the page was opened with, as the repo prompt's default. */
  repoParam: string;
  /** What an embed has turned on (embed/config.ts); absent on the full playground, which has everything. */
  features?: { has(name: "types" | "format" | "tabs" | "autosave" | "edit" | "close" | "git"): boolean };
};

export const AppContext = createContext<App>();
