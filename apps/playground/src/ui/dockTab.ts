import type { JSX } from "@solidjs/web";

/**
 * A tab of the dock, the pane under the preview (Dock.tsx). dockTabs.ts lists them: adding a pane to the playground is
 * one of these there.
 */
export interface DockTab {
  /** In the pane's id (`dock-pane-<id>`). */
  id: string;
  title: string;
  /** The tab's tooltip. */
  tip: string;
  /** An icon class (`i-lucide-…`). */
  icon: string;
  /** Whether the dock offers the tab now (tracked); always, without it. Its pane is unmounted while it doesn't. */
  when?: () => boolean;
  /** Tracked: when it changes to something truthy, the dock switches to the tab (the debugger pausing). */
  attention?: () => unknown;
  /** What the dock's header shows next to the tabs while this one is picked: counts, buttons. */
  Head?: () => JSX.Element;
  /** The pane. It stays mounted while another tab is picked (a terminal doesn't survive a remount), hidden. */
  Body: () => JSX.Element;
}
