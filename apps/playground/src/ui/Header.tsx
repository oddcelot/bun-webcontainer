import { Show, useContext } from "solid-js";
import { DOCS } from "../base";
import { chordKeys, keysFor } from "../keymap";
import logo from "../bun-logo.svg";
import { AppContext, type App } from "./context";
import { AutosaveTip } from "./EditorPane";
import { ProjectPicker } from "./ProjectPicker";
import { ShareMenu } from "./ShareMenu";
import { Shortcuts } from "./Shortcuts";
import { Storage } from "./Storage";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";
import { Menu, MenuItem, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Tip } from "@runbun/ui/solid/Tip";

const CANT_RUN = "This browser can't run code here";

/**
 * Shown when the page has a runner on this machine (`bunx @runbun/connect`): pressed, runs go to native Bun there;
 * not pressed, to the in-browser runtime. A running program starts again on the other side.
 */
function LocalBunToggle(props: { rt: NonNullable<App["runtime"]> }) {
  const rt = props.rt;
  const on = () => rt.current() === "local";
  const native = () => {
    const i = rt.info();
    return i ? `Bun ${i.bun} on this machine (sandbox: ${i.sandbox})` : "Bun on this machine";
  };
  const tip = () => {
    switch (rt.local()) {
      case "connecting":
        return "Connecting to the runner on this machine…";
      case "lost":
        return "The runner on this machine isn't reachable. Start it (bunx @runbun/connect) and reload.";
    }
    if (!rt.browserOk) return `Runs go to ${native()}: this browser can't run code itself.`;
    return on() ? `Runs go to ${native()}. Click to run in the browser instead.` : `Runs go to the in-browser runtime. Click to run with ${native()}.`;
  };
  return (
    <Tip
      id="local-bun"
      aria-pressed={on() ? "true" : "false"}
      data-state={rt.local()}
      disabled={rt.local() !== "connected" || !rt.browserOk}
      tip={tip()}
      onClick={() => void rt.switchTo(on() ? "browser" : "local")}
    >
      <i class={rt.local() === "lost" ? "i-lucide-unplug" : "i-lucide-cpu"} aria-hidden="true" /> Local Bun
    </Tip>
  );
}

export function Header() {
  const app = useContext(AppContext);
  const s = app.session;
  const ws = app.workspace;

  return (
    <>
      {/* The h1 holds only the page's stable name, so crawlers don't read it run into this visit's random one. */}
      <div class="title">
        <span class="logo" aria-hidden="true" />
        <h1 class="sr-only">Bun Playground: run Bun in your browser</h1>
        <span id="title" aria-hidden="true">
          <Title />
        </span>
      </div>
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
      <Show when={app.runtime?.local() !== "none" ? app.runtime : undefined}>{(rt) => <LocalBunToggle rt={rt()} />}</Show>
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
      <Show when={app.storage}>
        <Storage id="storage" />
      </Show>
      <Shortcuts id="shortcuts" />
      <ThemePicker />
    </>
  );
}
