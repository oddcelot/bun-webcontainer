import "virtual:uno.css";
// The landing page's pixel fonts (index.html, style.css #landing); only fetched where used.
import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/pixelify-sans/latin-500.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/pixelify-sans/latin-700.css";
// The landing page's shared 8-bit parts (cards, buttons, dumplings); see style.css #landing.
import "@runbun/ui/css/retro.css";
import { HOSTING } from "./hosting";

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
    document.title = `Bun Playground · ${sessionStorage.getItem("title") || "Bun playground"} · ${HOSTING.name}`;
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
  // ?open (index.html) has done its job: a reload or a share link doesn't need it.
  const url = new URL(location.href);
  if (url.searchParams.has("open")) {
    url.searchParams.delete("open");
    history.replaceState(history.state, "", url);
  }
  showPlayground();
  void import("./main");
} else {
  // The CRT on the landing page (src/landing/crt.ts): "Open the playground" zooms into its screen. Without WebGL, or
  // with reduced motion, the playground just replaces the page.
  const screen = document.querySelector<HTMLElement>("#landing .crt-screen");
  const crt = screen && !matchMedia("(prefers-reduced-motion: reduce)").matches ? import("./landing/crt").then((m) => m.startLandingCrt(screen)) : Promise.resolve(null);
  // The sky in the window on its wall.
  const sky = document.querySelector<HTMLCanvasElement>("#landing .sky");
  if (sky) void import("./landing/sky").then((m) => m.startSky(sky));
  // The page's scheme (index.html's head script set it): its switches (the header's, and the light switch on the wall)
  // flip and keep it; until then it follows the system's. The live example takes the same one.
  const system = matchMedia("(prefers-color-scheme: dark)");
  const switches = document.querySelectorAll<HTMLButtonElement>("#landing [data-scheme-switch]");
  const demo = document.querySelector("#landing bun-playground.demo");
  const setScheme = (scheme: string) => {
    root.dataset.scheme = scheme;
    demo?.setAttribute("theme", scheme);
    for (const button of switches) button.setAttribute("aria-label", scheme === "dark" ? "Switch to day" : "Switch to night");
  };
  setScheme(root.dataset.scheme === "dark" ? "dark" : "light");
  system.addEventListener("change", () => {
    try {
      if (localStorage.getItem("landing.scheme")) return;
    } catch {}
    setScheme(system.matches ? "dark" : "light");
  });
  for (const button of switches) {
    button.hidden = false;
    button.addEventListener("click", () => {
      setScheme(root.dataset.scheme === "dark" ? "light" : "dark");
      try {
        localStorage.setItem("landing.scheme", root.dataset.scheme!);
      } catch {}
    });
  }
  // Its sounds, and the header's button for them.
  const landing = document.getElementById("landing");
  if (landing) void import("./landing/sound").then((m) => m.startSounds(landing, landing.querySelector<HTMLButtonElement>(".sound")));
  let opening = false;
  async function openPlayground() {
    if (opening) return;
    opening = true;
    const monitor = await crt;
    // No monitor, or it isn't shown (a narrow screen, style.css): open without the zoom.
    if (!monitor || !screen?.getClientRects().length) {
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
