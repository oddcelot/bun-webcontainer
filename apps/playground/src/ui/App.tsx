import { Show, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Resizable, type RootChildrenProps } from "@kobalte/core/resizable";
import { matches, recordingKeys } from "../keymap";
import { Preview } from "./Preview";
import { pref } from "../prefs";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Header } from "./Header";
import { StatusToast } from "./Status";
import { StatusBar, statusDisplay } from "./StatusBar";
import { Unsupported } from "./Unsupported";

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
export function App() {
  const app = useContext(AppContext);
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
  const toggle = (i: number) => {
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
  onSettled(() => {
    // On the way down, and stopped there: the editor doesn't get a key that ran a command (its own keymap ignores
    // preventDefault, and has Mod+Enter as "insert a blank line"). Not while the shortcuts dialog records keys.
    const onKey = (e: KeyboardEvent) => {
      const s = app.session;
      if (recordingKeys()) return;
      if (matches("run", e)) s.canRun && !s.busy.run && s.ready() && app.run();
      else if (matches("stop", e)) app.stop();
      else if (matches("toggleExplorer", e)) toggleColumn(0);
      else if (matches("togglePreview", e)) toggle(0);
      else if (matches("toggleConsole", e)) toggle(1);
      else return;
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
        <Resizable
          onSizesChange={(sizes) => {
            setColumnSizes(sizes);
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
                      <FileTree />
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
                              {() => <Console />}
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
        <Show when={statusDisplay() === "toast"}>
          <StatusToast status={app.session.status()} />
        </Show>
      </main>
      <StatusBar
        treeShown={columnSizes()[0] > 0}
        toggleTree={() => toggleColumn(0)}
        previewShown={columnSizes()[2] > 0 && rowSizes()[0] > 0}
        consoleShown={columnSizes()[2] > 0 && rowSizes()[1] > 0}
        toggle={toggle}
      />
    </>
  );
}
