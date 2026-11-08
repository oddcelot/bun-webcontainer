// The header's "Open playground" (components/SocialIcons.astro): a small CRT monitor pops out of the button, showing
// the playground (@runbun/ui/crt), the page zooms into its screen, the CRT look settles to a plain picture of the
// playground, and only then does the browser navigate there. The playground is on another origin, so there is no live
// handover: the last frame stays up until the playground paints. Modified clicks, reduced motion and no WebGL just
// follow the link.

/** The playground's URL for `link`, opening the playground itself rather than its landing page (?open). */
function target(link: HTMLAnchorElement) {
  const url = new URL(link.href);
  url.searchParams.set("open", "");
  return url.href.replace(/([?&])open=(&|$)/, "$1open$2");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openPlayground(event: MouseEvent, link: HTMLAnchorElement) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.querySelector(".crt-launch")) return;
  event.preventDefault();
  const href = target(link);
  void launch(link, href).catch((error) => {
    console.warn("[crt]", error);
    location.assign(href);
  });
}

async function launch(link: HTMLAnchorElement, href: string) {
  const { fillWindow, startCrt } = await import("@runbun/ui/crt/shader");
  const layer = document.createElement("div");
  layer.className = "crt-launch";
  layer.innerHTML = `<div class="crt-launch-backdrop"></div><div class="crt-launch-monitor"><div class="crt-launch-screen"><canvas></canvas></div></div>`;
  const backdrop = layer.querySelector<HTMLElement>(".crt-launch-backdrop")!;
  const monitor = layer.querySelector<HTMLElement>(".crt-launch-monitor")!;
  const screen = layer.querySelector<HTMLElement>(".crt-launch-screen")!;
  // Below the button, right-aligned with it, kept inside the window.
  const button = link.getBoundingClientRect();
  const width = Math.min(260, innerWidth - 32);
  monitor.style.width = `${width}px`;
  monitor.style.left = `${Math.max(16, Math.min(button.right - width, innerWidth - width - 16))}px`;
  monitor.style.top = `${button.bottom + 14}px`;
  document.body.append(layer);
  const crt = startCrt(screen);
  if (!crt) {
    layer.remove();
    location.assign(href);
    return;
  }
  // Back from the playground (the back/forward cache restores this page as it was): drop the monitor.
  addEventListener(
    "pageshow",
    (e) => {
      if (!e.persisted) return;
      crt.stop();
      layer.remove();
    },
    { once: true },
  );

  // Pop out of the button.
  const box = monitor.getBoundingClientRect();
  const s = button.width / box.width;
  monitor.style.transformOrigin = "top right";
  const pop = monitor.animate(
    [
      { transform: `translate(${button.right - box.right}px, ${button.top - box.top}px) scale(${s})`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 380, easing: "cubic-bezier(0.2, 1.3, 0.4, 1)" },
  );
  backdrop.animate([{ opacity: 0 }, { opacity: 0.5 }], { duration: 380, fill: "forwards" });
  await pop.finished;
  await sleep(450);

  // Zoom into the screen until it fills the window, still a CRT on the way in.
  const zoom = fillWindow(screen.getBoundingClientRect(), monitor.getBoundingClientRect());
  crt.lock();
  monitor.style.transformOrigin = zoom.origin;
  backdrop.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 1100, fill: "forwards" });
  await monitor.animate([{ transform: "none" }, { transform: zoom.transform }], {
    duration: 1100,
    easing: "cubic-bezier(0.65, 0, 0.35, 1)",
    fill: "forwards",
  }).finished;

  // Filling the window: settle to the plain playground, then go there.
  await crt.settle(600);
  location.assign(href);
}
