import { Show, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Resizable, type RootChildrenProps } from "@kobalte/core/resizable";
import { matches } from "../keymap";
import { pref } from "../prefs";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Header } from "./Header";
import { Preview } from "./Preview";
import { StatusBar } from "./StatusBar";
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
  // Which of preview and console are shown, for the status bar's toggles.
  const [rowSizes, setRowSizes] = createSignal(rows);
  // The preview-over-console split, for the shortcuts that hide either.
  let split: RootChildrenProps | undefined;
  // The split from before one was hidden, to show both again at.
  let shown = rows;
  const toggle = (i: number) => {
    if (!split) return;
    const sizes = split.sizes;
    if (sizes.every((n) => n > 0)) shown = sizes;
    // Hiding one gives the other all the room (so with the other hidden, it swaps them).
    split.setSizes(sizes[i] > 0 ? (i ? [1, 0] : [0, 1]) : shown);
  };
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = app.session;
      if (matches("run", e)) s.canRun && !s.busy.run && s.ready() && app.run();
      else if (matches("stop", e)) app.stop();
      else if (matches("togglePreview", e)) toggle(0);
      else if (matches("toggleConsole", e)) toggle(1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
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
        <Resizable onSizesChange={saveColumns}>
          <Resizable.Panel panelId="tree-panel" initialSize={columns[0]} minSize="120px">
            <nav id="tree">
              <FileTree />
            </nav>
          </Resizable.Panel>
          <Resizable.Handle class="resize-handle" aria-label="Resize file tree" />
          <Resizable.Panel panelId="editor-panel" initialSize={columns[1]} minSize="200px">
            <section id="editor-pane">
              <EditorPane />
            </section>
          </Resizable.Panel>
          <Resizable.Handle class="resize-handle" aria-label="Resize editor and preview" />
          <Resizable.Panel panelId="right" initialSize={columns[2]} minSize="200px">
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
                      <Preview />
                    </Resizable.Panel>
                    <Resizable.Handle class="resize-handle" aria-label="Resize preview and console" />
                    <Resizable.Panel panelId="console-wrap" initialSize={rows[1]} minSize="60px">
                      <Console />
                    </Resizable.Panel>
                  </>
                );
              }}
            </Resizable>
          </Resizable.Panel>
        </Resizable>
      </main>
      <StatusBar previewShown={rowSizes()[0] > 0} consoleShown={rowSizes()[1] > 0} toggle={toggle} />
    </>
  );
}
