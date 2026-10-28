import { createContext } from "solid-js";
import type { createConsole } from "../console";
import type { LogFn } from "../runner";
import type { VFS } from "../vfs";
import type { Previews } from "./previews";
import type { Session } from "./session";
import type { Workspace } from "./workspace";

/** What the UI needs from main.ts, which still owns the engine (VFS, runner, tabs, file tree). */
export type App = {
  session: Session;
  workspace: Workspace;
  previews: Previews;
  /** The console's terminal; the Console pane attaches it. */
  terminal: ReturnType<typeof createConsole>;
  clearConsole(): void;
  vfs: VFS;
  log: LogFn;
  run(): void;
  install(): void;
  /** Reloads with `?example=` or `?repo=` (picker values for repos are `repo:<owner/repo>`). */
  openProject(value: string): void;
  /** Creates an empty file and opens it. */
  newFile(path: string): void;
  openFolder(files: File[]): void;
  /** The `?repo=` the page was opened with, as the repo prompt's default. */
  repoParam: string;
};

export const AppContext = createContext<App>();
