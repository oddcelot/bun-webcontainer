import { Show, useContext } from "solid-js";
import { AppContext } from "./context";
import { Console } from "./Console";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { Header } from "./Header";
import { Preview } from "./Preview";
import { Unsupported } from "./Unsupported";

/** The page: header, then the file tree, the editor and the preview over the console. */
export function App() {
  const app = useContext(AppContext);
  return (
    <>
      <header>
        <Header />
      </header>
      <Show when={!app.session.canRun}>
        <Unsupported checks={app.support} />
      </Show>
      <main>
        <nav id="tree">
          <FileTree />
        </nav>
        <section id="editor-pane">
          <EditorPane />
        </section>
        <div id="right">
          <Preview />
          <div id="console-wrap">
            <Console />
          </div>
        </div>
      </main>
    </>
  );
}
