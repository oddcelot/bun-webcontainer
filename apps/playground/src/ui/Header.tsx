import { Show, createSignal, untrack, useContext } from "solid-js";
import { DOCS } from "../base";
import { chordKeys, keysFor } from "../keymap";
import logo from "../bun-logo.svg";
import { AppContext, type App } from "./context";
import { AutosaveTip } from "./EditorPane";
import { LocalBunSetup } from "./LocalBunSetup";
import { ProjectPicker } from "./ProjectPicker";
import { ShareMenu } from "./ShareMenu";
import { Shortcuts } from "./Shortcuts";
import { Storage } from "./Storage";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";
import { Menu, MenuItem, MenuTrigger } from "@runbun/ui/solid/Menu";
import { Tip } from "@runbun/ui/solid/Tip";
import { Button } from "@runbun/ui/solid/Button";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";

const CANT_RUN = "This browser can't run code here";

/**
 * Where runs go, on the full playground. With a runner on this machine (`bunx @runbun/connect`): pressed, runs go to
 * native Bun there; not pressed, to the in-browser runtime; a running program starts again on the other side. Without
 * one (or once it stopped), a click opens LocalBunSetup: how to start it.
 */
function LocalBunToggle(props: { rt: NonNullable<App["runtime"]> }) {
  // The same runtime object for as long as the <Show> around this renders it: read once.
  const rt = untrack(() => props.rt);
  const on = () => rt.current() === "local";
  /** The setup dialog, for a click with no runner connected. */
  const [setup, setSetup] = createSignal(false);
  const native = () => {
    const i = rt.info();
    return i ? `Bun ${i.bun} on this machine (sandbox: ${i.sandbox})` : "Bun on this machine";
  };
  const tip = () => {
    switch (rt.local()) {
      case "connecting":
        return "Connecting to the runner on this machine…";
      case "lost":
        return "The runner isn't reachable. Click to see how to start it.";
      case "none":
        return "Run with Bun on this machine. Click to set up.";
    }
    if (!rt.browserOk) return `Running on ${native()}. This browser can't run code.`;
    return on() ? `Running on ${native()}. Click to run in the browser.` : `Running in the browser. Click to run on ${native()}.`;
  };
  return (
    <>
      <Tip
        id="local-bun"
        aria-pressed={on() ? "true" : "false"}
        data-state={rt.local()}
        disabled={rt.local() === "connecting" || (rt.local() === "connected" && !rt.browserOk)}
        tip={tip()}
        onClick={() => (rt.local() === "connected" ? void rt.switchTo(on() ? "browser" : "local") : setSetup(true))}
      >
        <i class={rt.local() === "lost" ? "i-lucide-unplug" : "i-lucide-cpu"} aria-hidden="true" /> Local Bun
      </Tip>
      <LocalBunSetup open={setup()} onOpenChange={setSetup} lost={rt.local() === "lost"} browserOk={rt.browserOk} />
      {/* Someone else's project (a share link, a GitHub repo) runs natively only once the reader agrees (boot.ts). */}
      <Dialog open={rt.asking() !== undefined} onOpenChange={(open) => !open && rt.answer(false)}>
        <DialogTitle>Run {rt.asking()} on this machine?</DialogTitle>
        <DialogDescription>
          This is someone else's code. Local Bun runs it sandboxed. It can't read your home folder or write outside the
          project, but it can use the network, including other services on this machine and your local network.
          {rt.browserOk ? " In the browser it can reach neither." : ""}
        </DialogDescription>
        <DialogActions>
          <DialogClose>{rt.browserOk ? "Keep it in the browser" : "Don't run it"}</DialogClose>
          <Button primary onClick={() => rt.answer(true)}>
            Run on this machine
          </Button>
        </DialogActions>
      </Dialog>
    </>
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
      <Show when={app.runtime}>{(rt) => <LocalBunToggle rt={rt()} />}</Show>
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
          tip={ws.watch() ? "Restarts on every save (bun --watch). Click to turn off." : "Restarts only on Run. Click to restart on every save."}
          onClick={() => ws.setWatch(!ws.watch())}
        >
          <i class={ws.watch() ? "i-lucide-refresh-cw" : "i-lucide-refresh-cw-off"} aria-hidden="true" />
        </Tip>
      </span>
      <Tip as="a" id="docs" href={DOCS} target="_blank" rel="noopener" tip="Documentation (opens in a new tab)">
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
