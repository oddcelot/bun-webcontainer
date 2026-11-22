import { CONTENT_ORIGIN } from "../contentOrigin";
import type { DockTab } from "./dockTab";

/** The frame Solid's devtools render into from the preview page (previewDevtools.ts finds it by its name). */
function DevtoolsBody() {
  return <iframe id="devtools-frame" name="runbun-devtools" title="Solid devtools" src="about:blank" />;
}

/** A prototype: offered for a project that depends on @solidjs/start-devtools, where the preview is on this origin. */
export const devtoolsTab: DockTab = {
  id: "devtools",
  title: "Devtools",
  tip: "Solid's devtools, for the app in the preview",
  icon: "i-lucide-activity",
  when: (app) => {
    if (CONTENT_ORIGIN || !app.session.ready()) return false;
    try {
      return app.vfs.readText("package.json")?.includes('"@solidjs/start-devtools"') ?? false;
    } catch {
      return false;
    }
  },
  Body: DevtoolsBody,
};
