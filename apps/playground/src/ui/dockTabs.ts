import { consoleTab } from "./Console";
import { debugTab } from "./DebugPanel";
import type { DockTab } from "./dockTab";

/** The dock's tabs, in order; the first one offered is the one a page opens on. */
export const DOCK_TABS: DockTab[] = [consoleTab, debugTab];
