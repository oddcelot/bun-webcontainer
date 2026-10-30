import { Show, useContext } from "solid-js";
import { Resizable } from "@kobalte/core/resizable";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Header } from "./Header";
import { Preview } from "./Preview";
import { Unsupported } from "./Unsupported";

/** Panel sizes as fractions, kept across reloads. */
function savedSizes(key: string, fallback: number[]): number[] {
  try {
    const sizes = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(sizes) && sizes.length === fallback.length && sizes.every((n) => typeof n === "number")) return sizes;
  } catch {}
  return fallback;
}

const saveSizes = (key: string) => (sizes: number[]) => localStorage.setItem(key, JSON.stringify(sizes));

/** The page: header, then the file tree, the editor and the preview over the console, with draggable borders between them. */
export function App() {
  const app = useContext(AppContext);
  // Per panel, not the root's initialSizes: the root's list only reached the first panel after a reload.
  const columns = savedSizes("layout.columns", [0.14, 0.43, 0.43]);
  const rows = savedSizes("layout.right", [0.5, 0.5]);
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
        <Resizable onSizesChange={saveSizes("layout.columns")}>
          {() => (
            <>
              <Resizable.Panel panelId="tree-panel" initialSize={columns[0]} minSize="120px">
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
              <Resizable.Panel panelId="right" initialSize={columns[2]} minSize="200px">
                {() => (
                  <Resizable orientation="vertical" onSizesChange={saveSizes("layout.right")}>
                    {() => (
                      <>
                        <Resizable.Panel panelId="preview-panel" initialSize={rows[0]} minSize="80px">
                          {() => <Preview />}
                        </Resizable.Panel>
                        <Resizable.Handle class="resize-handle" aria-label="Resize preview and console" />
                        <Resizable.Panel panelId="console-wrap" initialSize={rows[1]} minSize="60px">
                          {() => <Console />}
                        </Resizable.Panel>
                      </>
                    )}
                  </Resizable>
                )}
              </Resizable.Panel>
            </>
          )}
        </Resizable>
      </main>
    </>
  );
}
