import "virtual:uno.css";
// The landing page's pixel fonts (index.html, style.css #landing); only fetched where used.
import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/vt323/latin-400.css";

// index.html's script. On the landing page (runbun.dev/ on a first visit), "Open the playground" starts the
// playground in place: no navigation, and the landing page is dropped. index.html's head script picks the view.
const root = document.documentElement;

/** Shows the playground in place of the landing page. */
function showPlayground() {
  // From /about, the playground is at the home page's URL: a reload there opens it again.
  if (location.pathname.endsWith("/about")) history.replaceState(null, "", location.pathname.replace(/about$/, "") + location.search + location.hash);
  root.dataset.view = "app";
  document.getElementById("landing")?.remove();
  try {
    // Later visits skip the landing page (index.html's head script reads this).
    localStorage.setItem("playground.opened", "1");
    document.title = `Bun Playground · ${sessionStorage.getItem("title") || "Bun playground"} · runbun.dev`;
  } catch {}
}

/** Resolves once the playground has rendered its header (mountUI drops data-booting). */
function rendered() {
  return new Promise<void>((resolve) => {
    if (!("booting" in root.dataset)) return resolve();
    const observer = new MutationObserver(() => {
      if ("booting" in root.dataset) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-booting"] });
  });
}

if (root.dataset.view === "app") {
  showPlayground();
  void import("./main");
} else {
  // The CRT on the landing page (src/landing/crt.ts): "Open the playground" zooms into its screen. Without WebGL, or
  // with reduced motion, the playground just replaces the page.
  const screen = document.querySelector<HTMLElement>("#landing .crt-screen");
  const crt = screen && !matchMedia("(prefers-reduced-motion: reduce)").matches ? import("./landing/crt").then((m) => m.startLandingCrt(screen)) : Promise.resolve(null);
  let opening = false;
  async function openPlayground() {
    if (opening) return;
    opening = true;
    const monitor = await crt;
    if (!monitor) {
      showPlayground();
      void import("./main");
      return;
    }
    // The playground boots during the zoom, laid out (but hidden) under the landing page.
    root.dataset.view = "opening";
    void import("./main");
    await monitor.zoom(showPlayground, rendered());
  }
  for (const button of document.querySelectorAll("[data-open-playground]")) button.addEventListener("click", openPlayground);
  // The live example's <bun-playground> element: the one this deploy serves at /embed.js, framing this deploy.
  const element = document.createElement("script");
  element.type = "module";
  element.src = `${import.meta.env.BASE_URL}embed.js`;
  document.head.append(element);
}
