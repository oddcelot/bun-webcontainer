import { Show, createEffect, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Resizable, type RootChildrenProps } from "@kobalte/core/resizable";
import { COMMANDS, TILING_COMMANDS, keysFor, matches, recordingKeys, type Command, type TilingCommand } from "../keymap";
import { Palette, openPalette, type PaletteCommand } from "./Palette";
import { openSettings } from "./Settings";
import { openShortcuts } from "./Shortcuts";
import { Preview } from "./Preview";
import { pref } from "../prefs";
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
import { Tiles, createTiles, runTilingCommand, setTilingMode, tilingMode } from "./Tiles";
import type { Sized } from "../projectConfig";

/** Panel sizes as fractions, kept across reloads. A hidden panel isn't kept: after a reload it opens at its size from before. */
function sizesPref(key: string, fallback: number[]) {
  const [sizes, setSizes] = pref(key, fallback, {
    deserialize(data) {
      const sizes: unknown = JSON.parse(data);
      if (Array.isArray(sizes) && sizes.length === fallback.length && sizes.every((n) => typeof n === "number")) return sizes;
      throw new Error(`${key}: expected ${fallback.length} sizes`);
    },
  });
  // Read once: each tab keeps its own layout while open, and a reload takes the last one saved.
  return [untrack(sizes), (next: number[]) => next.every((n) => n > 0) && setSizes(next)] as const;
}

/** The page: header, then the file tree, the editor and the preview over the console, with draggable borders between them, then the status bar. */
/** The commands whose keys work anywhere on the page (App's listener), in the order they're tried. */
const GLOBAL: Command[] = ["run", "stop", "toggleExplorer", "toggleGit", "togglePreview", "toggleConsole", "showDevtools", "quickOpen", "commandPalette"];

export function App() {
  const app = useContext(AppContext);
  // The tiling layout (ui/Tiles.tsx), when this page uses it: then it places and toggles the panels, not the columns below.
  const tiling = tilingMode() ? createTiles() : undefined;
  // Per panel, not the root's initialSizes: the root's list only reached the first panel after a reload.
  const [columns, saveColumns] = sizesPref("layout.columns", [0.14, 0.43, 0.43]);
  const [rows, saveRows] = sizesPref("layout.right", [0.5, 0.5]);
  // Which of tree, preview and console are shown, for the status bar's toggles.
  const [columnSizes, setColumnSizes] = createSignal(columns);
  const [rowSizes, setRowSizes] = createSignal(rows);
  // The tree-editor-right columns, for the shortcuts that hide the tree or the whole right column.
  let cols: RootChildrenProps | undefined;
  // Each column's width from before it was hidden, to show it again at.
  const widths = [...columns];
  const toggleColumn = (i: number) => {
    if (tiling) return tiling.toggle(i === 0 ? "files" : "preview");
    if (!cols) return;
    const [tree, editor, right] = cols.sizes;
    if (i === 0) {
      if (tree > 0) widths[0] = tree;
      const size = tree > 0 ? 0 : widths[0];
      // The editor and the right column give up (or take) the tree's room in proportion to their widths.
      const scale = (1 - size) / (editor + right);
      cols.setSizes([size, editor * scale, right * scale]);
    } else {
      if (right > 0) widths[2] = right;
      // The editor alone takes (or gives up) the right column's room, keeping some for itself.
      const size = right > 0 ? 0 : Math.min(widths[2], editor + right - 0.2);
      cols.setSizes([tree, editor + right - size, size]);
    }
  };
  // The preview-over-console split, for the shortcuts that hide either or both.
  let split: RootChildrenProps | undefined;
  // The split from before one was hidden, to show both again at.
  let shown = rows;
  // Whether `panels` (the project's or the host's) hid the console and the reader hasn't toggled it since: it opens
  // when the program fails, since its output says why.
  let configHidConsole = false;
  const toggle = (i: number) => {
    if (i === 1) configHidConsole = false;
    if (tiling) return tiling.toggle(i ? "console" : "preview");
    if (!split || !cols) return;
    const sizes = split.sizes;
    // With both hidden, the right column is too: show it with just this one.
    if (!(cols.sizes[2] > 0)) {
      split.setSizes(i ? [0, 1] : [1, 0]);
      toggleColumn(2);
    } else if (!(sizes[i] > 0)) split.setSizes(shown);
    // Hiding the last one shown hides the right column, so the editor takes the room.
    else if (!(sizes[1 - i] > 0)) toggleColumn(2);
    else {
      shown = sizes;
      split.setSizes(i ? [1, 0] : [0, 1]);
    }
  };
  // A project's runbun.json `sizes` (percent): the shares it asks for, the tree's and the right column's kept for when
  // they show again if hidden now.
  const setShares = (s: Partial<Record<Sized, number>>) => {
    if (!cols || !split) return;
    const [tree, editor, right] = cols.sizes;
    if (s.files !== undefined) widths[0] = s.files / 100;
    const t = tree > 0 && s.files !== undefined ? s.files / 100 : tree;
    const rest = 1 - t;
    let e = rest;
    let r = 0;
    if (s.editor !== undefined) {
      if (right > 0) r = rest - (e = (rest * s.editor) / 100);
      else widths[2] = (rest * (100 - s.editor)) / 100;
    } else if (right > 0) r = rest - (e = (editor * rest) / (editor + right));
    cols.setSizes([t, e, r]);
    if (s.preview !== undefined) {
      shown = [s.preview / 100, 1 - s.preview / 100];
      if (split.sizes.every((n) => n > 0)) split.setSizes(shown);
    }
  };
  // A project's runbun.json `panels`: shown or hidden as it asks, the others as they are; then its `sizes`. What they
  // change isn't the reader's layout, so it isn't saved; a project with neither brings the saved layout back.
  let applying = false;
  let overridden = false;
  const saved = { columns: [...columns], rows: [...rows] };
  const setPanels = (want: { files?: boolean; preview?: boolean; console?: boolean } | null, shares: Partial<Record<Sized, number>> | null) => {
    if (!cols || !split) return;
    applying = true;
    if (!want && !shares) {
      if (overridden) {
        cols.setSizes(saved.columns);
        split.setSizes(saved.rows);
      }
      overridden = false;
      configHidConsole = false;
    } else {
      overridden = true;
      configHidConsole = want?.console === false;
      if (shares) setShares(shares);
      if (want?.files !== undefined && want.files !== cols.sizes[0] > 0) toggleColumn(0);
      const right = cols.sizes[2] > 0;
      const now = { preview: right && split.sizes[0] > 0, console: right && split.sizes[1] > 0 };
      const next = { preview: want?.preview ?? now.preview, console: want?.console ?? now.console };
      if (next.preview !== now.preview || next.console !== now.console) {
        if (!next.preview && !next.console) toggleColumn(2);
        else {
          if (!right) toggleColumn(2);
          const both = shares?.preview !== undefined ? shown : saved.rows.every((r) => r > 0) ? saved.rows : [0.5, 0.5];
          split.setSizes(next.preview && next.console ? both : next.preview ? [1, 0] : [0, 1]);
        }
      }
    }
    // The resize events the changes fire land before the next frame.
    requestAnimationFrame(() => (applying = false));
  };
  createEffect(
    () => [app.workspace.panels(), app.workspace.sizes()] as const,
    ([want, shares]) => {
      // The tiling layout takes a project's `panels`; its `sizes` name the classic columns, and are left out there.
      if (tiling) {
        configHidConsole = want?.console === false;
        tiling.override(want ? { files: want.files, preview: want.preview, console: want.console } : null);
      } else setPanels(want, shares);
    },
  );
  createEffect(
    () => app.session.settled().state,
    (state) => {
      if (state === "error" && configHidConsole && tiling) return tiling.reveal("console");
      if (state !== "error" || !configHidConsole || !cols || !split) return;
      if (cols.sizes[2] > 0 && split.sizes[1] > 0) return;
      // Like the panels it undoes, not the reader's layout to save.
      applying = true;
      toggle(1);
      requestAnimationFrame(() => (applying = false));
    },
  );
  const treeShown = () => (tiling ? tiling.shown("files") : columnSizes()[0] > 0);
  const previewShown = () => (tiling ? tiling.shown("preview") : columnSizes()[2] > 0 && rowSizes()[0] > 0);
  const consoleShown = () => (tiling ? tiling.shown("console") : columnSizes()[2] > 0 && rowSizes()[1] > 0);
  /** Runs a command of the page (a shortcut, or the command palette); false if it doesn't apply here, to leave the key be. */
  const perform = (command: Command): boolean => {
    const s = app.session;
    if ((TILING_COMMANDS as readonly Command[]).includes(command)) {
      if (tiling) runTilingCommand(tiling, command as TilingCommand);
      return !!tiling;
    }
    switch (command) {
      case "run":
        if (s.canRun && !s.busy.run && s.ready()) app.run();
        return true;
      case "stop":
        app.stop();
        return true;
      case "toggleExplorer":
        toggleColumn(0);
        return true;
      case "toggleGit":
        return toggleGit(app, treeShown(), () => toggleColumn(0));
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
    ...(tiling ? TILING_COMMANDS : []).map((c) => ({
      id: c,
      label: COMMANDS[c].label,
      get keys() {
        return keysFor(c);
      },
      run: () => void perform(c),
    })),
    { id: "layout", label: tiling ? "Switch to the classic layout (reloads)" : "Switch to the tiling layout (reloads)", run: () => setTilingMode(!tiling) },
    { id: "install", label: "Install dependencies", run: () => app.session.ready() && app.install(), when: () => app.session.canRun },
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
      const command = GLOBAL.find((c) => matches(c, e)) ?? (tiling && TILING_COMMANDS.find((c) => matches(c, e)));
      if (!command || !perform(command)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
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
        {/*
          Children as functions: Kobalte's Resizable and Resizable.Panel evaluate
          `typeof p.children === "function" ? p.children(...) : p.children`, and each read of p.children builds the
          JSX again, so plain children would render twice (a detached second editor, console and preview that live on).
        */}
        {tiling ? (
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
              preview: () => <Preview />,
              console: () => <Dock />,
            }}
          />
        ) : (
        <Resizable
          onSizesChange={(sizes) => {
            setColumnSizes(sizes);
            if (applying) return;
            saved.columns = sizes;
            saveColumns(sizes);
          }}
        >
          {(c) => {
            cols = c;
            return (
              <>
                <Resizable.Panel panelId="tree-panel" initialSize={columns[0]} minSize="120px" data-hidden={columnSizes()[0] > 0 ? undefined : ""}>
                  {() => (
                    <nav id="tree">
                      <Explorer />
                    </nav>
                  )}
                </Resizable.Panel>
                <Resizable.Handle class="resize-handle" aria-label="Resize file tree" />
                <Resizable.Panel panelId="editor-panel" initialSize={columns[1]} minSize="200px">
                  {() => (
                    <section id="editor-pane">
                      <EditorPane />
                    </section>
                  )}
                </Resizable.Panel>
                <Resizable.Handle class="resize-handle" aria-label="Resize editor and preview" />
                <Resizable.Panel panelId="right" initialSize={columns[2]} minSize="200px" data-hidden={columnSizes()[2] > 0 ? undefined : ""}>
                  {() => (
                    <Resizable
                      orientation="vertical"
                      onSizesChange={(sizes) => {
                        setRowSizes(sizes);
                        if (applying) return;
                        saved.rows = sizes;
                        saveRows(sizes);
                      }}
                    >
                      {(r) => {
                        split = r;
                        return (
                          <>
                            <Resizable.Panel panelId="preview-panel" initialSize={rows[0]} minSize="80px">
                              {() => <Preview />}
                            </Resizable.Panel>
                            <Resizable.Handle class="resize-handle" aria-label="Resize preview and console" />
                            <Resizable.Panel panelId="console-wrap" initialSize={rows[1]} minSize="60px">
                              {() => (
<Dock />
                              )}
                            </Resizable.Panel>
                          </>
                        );
                      }}
                    </Resizable>
                  )}
                </Resizable.Panel>
              </>
            );
          }}
        </Resizable>
        )}
      </main>
      <Palette commands={paletteCommands} />
      <StatusBar
        tiling={!!tiling}
        treeShown={treeShown()}
        toggleFiles={() => toggleFiles(app, treeShown(), () => toggleColumn(0))}
        toggleGit={() => toggleGit(app, treeShown(), () => toggleColumn(0))}
        previewShown={previewShown()}
        consoleShown={consoleShown()}
        toggle={toggle}
      />
    </>
  );
}
