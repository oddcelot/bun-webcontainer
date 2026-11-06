import { render } from "@solidjs/web";
import { App } from "./App";
import { AppContext, type App as AppApi } from "./context";

/** Renders the page into index.html's #app, replacing its static header (kept there for crawlers and no-JS visitors). */
export function mountUI(app: AppApi) {
  const root = document.getElementById("app")!;
  root.querySelector(":scope > header")?.remove();
  const dispose = render(
    () => (
      <AppContext value={app}>
        <App />
      </AppContext>
    ),
    root,
  );
  delete document.documentElement.dataset.booting;
  return dispose;
}
