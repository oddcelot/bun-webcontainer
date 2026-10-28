import { render } from "@solidjs/web";
import { App } from "./App";
import { AppContext, type App as AppApi } from "./context";

/** Renders the page into <body>, replacing index.html's static header (kept there for crawlers and no-JS visitors). */
export function mountUI(app: AppApi) {
  document.querySelector("body > header")?.remove();
  return render(
    () => (
      <AppContext value={app}>
        <App />
      </AppContext>
    ),
    document.body,
  );
}
