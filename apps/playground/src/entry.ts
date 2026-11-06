import "virtual:uno.css";

// index.html's script. On the landing page (runbun.dev/ on a first visit), "Open the playground" starts the
// playground in place: no navigation, and the landing page is dropped. index.html's head script picks the view.
const root = document.documentElement;

function openPlayground() {
  root.dataset.view = "app";
  document.getElementById("landing")?.remove();
  try {
    // Later visits skip the landing page (index.html's head script reads this).
    localStorage.setItem("playground.opened", "1");
    document.title = `Bun Playground · ${sessionStorage.getItem("title") || "Bun playground"} · runbun.dev`;
  } catch {}
  void import("./main");
}

if (root.dataset.view === "app") openPlayground();
else {
  for (const button of document.querySelectorAll("[data-open-playground]")) button.addEventListener("click", openPlayground);
  // The live example's <bun-playground> element: the one this deploy serves at /embed.js, framing this deploy.
  const element = document.createElement("script");
  element.type = "module";
  element.src = `${import.meta.env.BASE_URL}embed.js`;
  document.head.append(element);
}
