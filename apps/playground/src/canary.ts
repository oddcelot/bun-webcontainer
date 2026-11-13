// The canary build (CANARY=1 in `moon run playground:deploy-canary`) says so: a small badge that links the same page on
// runbun.dev, so nobody mistakes canary.runbun.dev for the real site. Production builds compile this to nothing.
// Not shown in /embed, which other sites frame (embed/main.ts doesn't call it).

const PRODUCTION = "https://runbun.dev";
const DISMISSED = "runbun-canary-badge-dismissed";

export function showCanaryBadge(): void {
  if (!import.meta.env.CANARY) return;
  try {
    if (sessionStorage.getItem(DISMISSED)) return;
  } catch {}
  const badge = document.createElement("div");
  badge.className = "canary-badge";
  badge.setAttribute("role", "note");
  const link = document.createElement("a");
  link.href = PRODUCTION + location.pathname + location.search + location.hash;
  link.textContent = "Canary build, may be broken. Use runbun.dev";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Hide until this tab closes";
  close.setAttribute("aria-label", "Hide the canary notice");
  close.addEventListener("click", () => {
    badge.remove();
    try {
      sessionStorage.setItem(DISMISSED, "1");
    } catch {}
  });
  badge.append(link, close);
  document.body.append(badge);
}
