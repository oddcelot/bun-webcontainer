// The landing page's CRT (index.html, #landing .crt): a small monitor showing the playground (@runbun/ui/crt).
// "Open the playground" zooms the page into its screen; filling the window, the CRT look settles to a plain
// pass-through, then the screen fades out over the real playground (src/entry.ts).
import { fillWindow, nextFrame, startCrt } from "@runbun/ui/crt/shader";

export type Crt = {
  /** Zooms the page into the screen, calls `swap` once it fills the window, and fades out once `ready` settles. */
  zoom(swap: () => void, ready: Promise<unknown>): Promise<void>;
};

/** Starts the monitor in `screen` (a .crt-screen element holding a canvas), or null without WebGL. */
export function startLandingCrt(screen: HTMLElement): Crt | null {
  const crt = startCrt(screen);
  if (!crt) return null;
  return {
    async zoom(swap, ready) {
      const landing = document.getElementById("landing")!;
      // Freeze the scroll position (without the scrollbar's width changing the layout), then measure.
      const lockScroll = (e: Event) => e.preventDefault();
      addEventListener("wheel", lockScroll, { passive: false });
      addEventListener("touchmove", lockScroll, { passive: false });
      const target = fillWindow(screen.getBoundingClientRect(), landing.getBoundingClientRect());
      crt.lock();
      landing.style.transformOrigin = target.origin;
      landing.style.willChange = "transform";
      await landing.animate([{ transform: "none" }, { transform: target.transform }], {
        duration: 1300,
        easing: "cubic-bezier(0.65, 0, 0.35, 1)",
        fill: "forwards",
      }).finished;
      // The screen fills the window: move it onto the page as an overlay and swap the landing page for the playground
      // underneath, which keeps booting while the CRT look settles; fade out once the playground has rendered.
      const overlay = document.createElement("div");
      overlay.className = "crt-overlay";
      overlay.append(crt.canvas);
      document.body.append(overlay);
      removeEventListener("wheel", lockScroll);
      removeEventListener("touchmove", lockScroll);
      swap();
      await crt.settle(700);
      await Promise.race([ready, new Promise((r) => setTimeout(r, 10_000))]);
      await nextFrame();
      await overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: "ease-out", fill: "forwards" }).finished;
      crt.stop();
      overlay.remove();
    },
  };
}
