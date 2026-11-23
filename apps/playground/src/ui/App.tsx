import { Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { COMMANDS, TILING_COMMANDS, keysFor, matches, recordingKeys, tileKeyCommand, tileKeyHints, type Command, type TilingCommand } from "../keymap";
import { Palette, openPalette, type PaletteCommand } from "./Palette";
import { openSettings } from "./Settings";
import { openShortcuts } from "./Shortcuts";
import { Preview } from "./Preview";
import { watchOwnTabs } from "../preview";
import { AppContext } from "./context";
import { Dock } from "./Dock";
import { devtoolsOffered, showDevtools } from "./Devtools";
import { debugKey } from "./DebugPanel";
import { EditorPane } from "./EditorPane";
import { Explorer, toggleFiles, toggleGit } from "./Explorer";
import { inCommitBox } from "../git/store";
import { Header } from "./Header";
import { StatusBar } from "./StatusBar";
import { Unsupported } from "./Unsupported";
import { Tiles, createTiles, runTilingCommand } from "./Tiles";

/** The page: header, then the file tree, the editor, the preview and the console as tiles (ui/Tiles.tsx), then the status bar. */
/** The commands whose keys work anywhere on the page (App's listener), in the order they're tried. */
const GLOBAL: Command[] = ["run", "stop", "toggleExplorer", "toggleGit", "togglePreview", "toggleConsole", "showDevtools", "quickOpen", "commandPalette"];

export function App() {
  const app = useContext(AppContext);
  // The panels' layout: it places them, and shows and hides each.
  const tiling = createTiles();
  const toggleTree = () => tiling.toggle("files");
  // Whether `panels` (the project's or the host's) hid the console and the reader hasn't toggled it since: it opens
  // when the program fails, since its output says why.
  let configHidConsole = false;
  /** Shows or hides the preview (0) or the console (1). */
  const toggle = (i: number) => {
    if (i === 1) configHidConsole = false;
    tiling.toggle(i ? "console" : "preview");
  };
  // A project's runbun.json `panels` and `sizes`: shown, hidden and sized as it asks for as long as it is open. Not
  // the reader's layout, so not saved; a project with neither brings the saved layout back.
  createEffect(
    () => [app.workspace.panels(), app.workspace.sizes()] as const,
    ([want, shares]) => {
      configHidConsole = want?.console === false;
      tiling.override(want ? { files: want.files, preview: want.preview, console: want.console } : null);
      tiling.sizes(shares);
    },
  );
  createEffect(
    () => app.session.settled().state,
    (state) => {
      if (state === "error" && configHidConsole) tiling.reveal("console");
    },
  );
  const treeShown = () => tiling.shown("files");
  const previewShown = () => tiling.shown("preview");
  const consoleShown = () => tiling.shown("console");
  // Previews opened in browser tabs of their own ("Open in a new tab"): the pane hides while one is open, and shows again
  // when the last one closes, unless the reader showed it in the meantime. A reload is a close and an open: the pane
  // waits a moment before it shows.
  const ownTabs = new Set<string>();
  let hidForTabs = false;
  let check: ReturnType<typeof setTimeout> | undefined;
  const showUnlessOpen = (after: number) => {
    clearTimeout(check);
    check = setTimeout(() => {
      if (ownTabs.size || !hidForTabs) return;
      hidForTabs = false;
      if (!previewShown()) toggle(0);
    }, after);
  };
  watchOwnTabs((id, open) => {
    if (open) ownTabs.add(id);
    else if (ownTabs.delete(id)) showUnlessOpen(2000);
  });
  const openOwnTab = (url: string) => {
    window.open(url, "_blank", "noopener");
    if (!previewShown()) return;
    toggle(0);
    hidForTabs = true;
    // A tab that never says it opened (blocked, or still loading): the pane comes back.
    showUnlessOpen(10_000);
  };
  createEffect(previewShown, (shown) => {
    if (shown) hidForTabs = false;
  });
  // The tiling layout's keys: after `tileKeys` the next key runs a tiling command (keymap.ts tileKeyCommand), and a
  // hint lists them meanwhile. Moving and resizing take several presses, so those keep it open for a moment more.
  const [tileKeys, setTileKeys] = createSignal(false);
  let tileKeysEnd: ReturnType<typeof setTimeout> | undefined;
  const endTileKeys = () => {
    clearTimeout(tileKeysEnd);
    setTileKeys(false);
  };
  /** Whether the key was one of them (and so not the page's or the editor's). */
  const onTileKey = (e: KeyboardEvent): boolean => {
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return true;
    const command = tileKeyCommand(e);
    clearTimeout(tileKeysEnd);
    if (command && /^(move|tileGrow|tileShrink)/.test(command)) tileKeysEnd = setTimeout(endTileKeys, 1500);
    else endTileKeys();
    if (command) perform(command);
    return !!command || e.key === "Escape";
  };
  /** Runs a command of the page (a shortcut, or the command palette); false if it doesn't apply here, to leave the key be. */
  const perform = (command: Command): boolean => {
    const s = app.session;
    if (command === "tileKeys") {
      // From a preview's page the next key would go to that page: the playground takes the keyboard.
      if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
      clearTimeout(tileKeysEnd);
      setTileKeys(true);
      return true;
    }
    if ((TILING_COMMANDS as readonly Command[]).includes(command)) {
      runTilingCommand(tiling, command as TilingCommand);
      return true;
    }
    switch (command) {
      case "run":
        if (s.canRun && !s.busy.run && s.ready()) app.run();
        return true;
      case "stop":
        app.stop();
        return true;
      case "toggleExplorer":
        toggleTree();
        return true;
      case "toggleGit":
        return toggleGit(app, treeShown(), () => toggleTree());
      case "togglePreview":
        toggle(0);
        return true;
      case "toggleConsole":
        toggle(1);
        return true;
      case "showDevtools":
        if (!showDevtools(app)) return false;
        if (!consoleShown()) toggle(1);
        return true;
      case "quickOpen":
        openPalette("files");
        return true;
      case "commandPalette":
        openPalette("commands");
        return true;
      // The palette's: the editor's own keys run these where it has the focus.
      case "save":
        app.workspace.saveAll();
        return true;
      case "format":
        app.workspace.format();
        return true;
      case "closeTab":
        if (app.workspace.state.active) app.workspace.close(app.workspace.state.active);
        return true;
      case "send":
        if (s.canRun) app.previews.request(app.previews.state.active);
        return true;
    }
    return false;
  };
  /** What the command palette offers: the page's commands with their keys, and a few without. */
  const paletteCommands: PaletteCommand[] = [
    ...(["run", "stop", "send", "save", "format", "closeTab", "toggleExplorer", "toggleGit", "togglePreview", "toggleConsole", "showDevtools", "quickOpen"] as const).map((c) => ({
      id: c,
      label: COMMANDS[c].label,
      get keys() {
        return keysFor(c);
      },
      run: () => void perform(c),
      when: c === "showDevtools" ? () => devtoolsOffered(app) : c === "toggleGit" ? () => !!app.git : undefined,
    })),
    ...(["tileKeys", ...TILING_COMMANDS] as const).map((c) => ({
      id: c,
      label: COMMANDS[c].label,
      get keys() {
        return keysFor(c);
      },
      run: () => void perform(c),
    })),
    { id: "install", label: "Install dependencies", run: () => app.session.ready() && app.install(), when: () => app.session.canRun },
    { id: "showHidden", label: "Show or hide the project's hidden files", run: () => app.workspace.setShowHidden(!app.workspace.showHidden()), when: () => app.workspace.treeHidden().length > 0 },
    { id: "settings", label: "Open Settings", run: openSettings },
    { id: "shortcuts", label: "Keyboard shortcuts", run: openShortcuts },
  ];
  onSettled(() => {
    // On the way down, and stopped there: the editor doesn't get a key that ran a command (its own keymap ignores
    // preventDefault, and has Mod+Enter as "insert a blank line"). Not while the shortcuts dialog records keys.
    const onKey = (e: KeyboardEvent) => {
      const s = app.session;
      if (recordingKeys()) return;
      // Mod+Enter in the commit message box commits (GitPanel.tsx), it doesn't run the project.
      if (inCommitBox(e) && matches("run", e)) return;
      if (debugKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (tileKeys() && !matches("tileKeys", e)) {
        if (!onTileKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const command = GLOBAL.find((c) => matches(c, e)) ?? (["tileKeys", ...TILING_COMMANDS] as const).find((c) => matches(c, e));
      if (!command || !perform(command)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, { capture: true });
    // A click, or the window losing the keyboard, ends the tiling keys.
    addEventListener("pointerdown", endTileKeys, { capture: true });
    addEventListener("blur", endTileKeys);
    return () => {
      removeEventListener("keydown", onKey, { capture: true });
      removeEventListener("pointerdown", endTileKeys, { capture: true });
      removeEventListener("blur", endTileKeys);
    };
  });
  return (
    <>
      <header>
        <Header />
      </header>
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <main>
        <Tiles
          tiles={tiling}
          panes={{
            files: () => (
              <nav id="tree">
                <Explorer />
              </nav>
            ),
            editor: () => (
              <section id="editor-pane">
                <EditorPane />
              </section>
            ),
            preview: () => <Preview openTab={openOwnTab} />,
            console: () => <Dock />,
          }}
        />
      </main>
      <Show when={tileKeys()}>
        <div id="tile-keys" role="status">
          {tileKeyHints().map((h) => (
            <span>
              {h.keys.map((key) => (
                <kbd>{key}</kbd>
              ))}
              {h.does}
            </span>
          ))}
        </div>
      </Show>
      <Palette commands={paletteCommands} />
      <StatusBar
        treeShown={treeShown()}
        toggleFiles={() => toggleFiles(app, treeShown(), () => toggleTree())}
        toggleGit={() => toggleGit(app, treeShown(), () => toggleTree())}
        previewShown={previewShown()}
        consoleShown={consoleShown()}
        toggle={toggle}
      />
    </>
  );
}
