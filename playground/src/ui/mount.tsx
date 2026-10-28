import { render } from "@solidjs/web";
import { AppContext, type App } from "./app";
import { Header } from "./Header";

/** Renders the header into index.html's <header>, replacing its static fallback (render() appends). */
export function mountHeader(app: App) {
  const root = document.querySelector("header")!;
  root.replaceChildren();
  return render(
    () => (
      <AppContext value={app}>
        <Header />
      </AppContext>
    ),
    root,
  );
}
