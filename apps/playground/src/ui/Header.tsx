import { useContext } from "solid-js";
import { DOCS } from "../base";
import { chordKeys, keysFor } from "../keymap";
import logo from "../bun-logo.svg";
import { AppContext } from "./context";
import { AutosaveTip } from "./EditorPane";
import { ProjectPicker } from "./ProjectPicker";
import { ShareMenu } from "./ShareMenu";
import { Shortcuts } from "./Shortcuts";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";
import { Menu, MenuItem, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Tip } from "@runbun/ui/solid/Tip";

const CANT_RUN = "This browser can't run code here";

export function Header() {
  const app = useContext(AppContext);
  const s = app.session;
  const ws = app.workspace;

  return (
    <>
      <h1 class="title">
        <img src={logo} alt="" width="23" height="20" />
        <span class="sr-only">runbun.dev: Bun in your browser</span>
        <span id="title" aria-hidden="true">
          <Title />
        </span>
      </h1>
      <ProjectPicker />
      {/* Startup installs and runs the project itself, so Run and Install ignore clicks until it's done (no greying out meanwhile). */}
      <span id="run-group">
        <Tip
          id="run"
          tip={s.canRun ? "Run the project" : CANT_RUN}
          keys={s.canRun ? keysFor("run").map(chordKeys) : undefined}
          disabled={!s.canRun || !!s.busy.run}
          onClick={() => s.ready() && app.run()}
        >
          <i class="i-lucide-play" aria-hidden="true" /> Run
        </Tip>
        <Menu
          placement="bottom-start"
          trigger={
            <Tip as={MenuTrigger} id="run-more" disabled={!s.canRun} tip={s.canRun ? "More" : CANT_RUN} aria-label="More run actions">
              <i class="i-lucide-chevron-down" aria-hidden="true" />
            </Tip>
          }
        >
          <MenuItem icon="i-lucide-download" label="bun install" disabled={!!s.busy.install} onSelect={() => s.ready() && app.install()} />
        </Menu>
      </span>
      {/* What a save does: when edits save, and whether a save restarts the program. Icons only; the tooltips say which. */}
      <span id="save-group">
        <Tip
          id="autosave"
          aria-label="Auto-save"
          aria-pressed={ws.autosave() ? "true" : "false"}
          tip={<AutosaveTip on={ws.autosave()} />}
          onClick={() => ws.setAutosave(!ws.autosave())}
        >
          <i class={ws.autosave() ? "i-lucide-save" : "i-lucide-save-off"} aria-hidden="true" />
        </Tip>
        <Tip
          id="watch"
          aria-label="Restart on save"
          aria-pressed={ws.watch() ? "true" : "false"}
          tip={ws.watch() ? "A save restarts the running program, like bun --watch. Click to restart with Run only." : "Only Run restarts the program. Click to restart it on every save, like bun --watch."}
          onClick={() => ws.setWatch(!ws.watch())}
        >
          <i class={ws.watch() ? "i-lucide-refresh-cw" : "i-lucide-refresh-cw-off"} aria-hidden="true" />
        </Tip>
      </span>
      <Tip as="a" id="docs" href={DOCS} target="_blank" rel="noopener" tip="Documentation: what works, and how (opens in a new tab)">
        <i class="i-lucide-book-open" aria-hidden="true" /> Docs
      </Tip>
      <Tip id="share" popovertarget="share-menu" tip="Share this project">
        <i class="i-lucide-share-2" aria-hidden="true" /> Share
      </Tip>
      <ShareMenu />
      <Shortcuts id="shortcuts" />
      <ThemePicker />
    </>
  );
}
