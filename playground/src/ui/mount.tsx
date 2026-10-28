import { render, type JSX } from "@solidjs/web";
import { AppContext, type App } from "./app";
import { Console } from "./Console";
import { FileTree } from "./FileTree";
import { Header } from "./Header";
import { EditorPane } from "./EditorPane";

/**
 * Renders the Solid parts of the page into index.html's elements. render() appends, so each element's static
 * content is cleared first.
 */
export function mountUI(app: App) {
  const into = (selector: string, view: () => JSX.Element) => {
    const root = document.querySelector<HTMLElement>(selector)!;
    root.replaceChildren();
    render(() => <AppContext value={app}>{view()}</AppContext>, root);
  };
  into("header", () => <Header />);
  into("#tree", () => <FileTree />);
  into("#editor-pane", () => <EditorPane />);
  into("#console-wrap", () => <Console />);
}
