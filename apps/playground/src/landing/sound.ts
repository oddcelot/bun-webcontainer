// The landing page's sounds (index.html #landing): uisfx's arcade pack, synthesized in the browser (no audio files are
// fetched), on what a visitor does: over and on its links and buttons, the light switches, Run, opening the playground.
// The header's speaker button turns them off and on; uisfx keeps that in localStorage.
import { createUISFX, type CueName } from "uisfx";

/** Plays the page's sounds for what happens in `landing`; `toggle` is the button that turns them off and on. */
export function startSounds(landing: HTMLElement, toggle: HTMLButtonElement | null) {
  const ui = createUISFX({ pack: "arcade", volume: 0.6, preferences: { key: "landing.sound" } });
  const control = (target: EventTarget | null) => (target instanceof Element ? target.closest("a, button") : null);

  // A browser plays nothing before the visitor's first click (or key on a link or button, a click too): until then the
  // page is quiet and the button shows the sounds as off, whatever the saved choice.
  let awake = navigator.userActivation?.hasBeenActive ?? false;
  let woke: Event | undefined;
  const show = () => toggle?.setAttribute("aria-pressed", String(awake && ui.isEnabled()));
  const wake = (event: Event) => {
    awake = true;
    woke = event;
    void ui.unlock();
    show();
  };
  if (!awake) landing.addEventListener("click", wake, { once: true, capture: true });

  /** What a click on `target` sounds like. The page's own listeners (entry.ts) have run by now. */
  function cue(event: MouseEvent, target: Element): CueName {
    if (target.matches("[data-scheme-switch]")) return document.documentElement.dataset.scheme === "dark" ? "toggle-off" : "toggle-on";
    if (target.matches("[data-open-playground]")) return "start";
    // The live example's Run button is in the element's shadow tree.
    if (event.composedPath().some((el) => el instanceof Element && el.classList.contains("play"))) return "play";
    return "press";
  }
  landing.addEventListener("click", (event) => {
    const target = control(event.target) ?? (event.target instanceof Element ? event.target.closest("bun-playground") : null);
    if (!target || target === toggle) return;
    const name = cue(event, target);
    if (name !== "press" || target.matches("a, button")) ui.play(name);
  });
  // Onto a link or a button with a mouse, not from one of its own parts.
  landing.addEventListener("pointerover", (event) => {
    const target = control(event.target);
    if (!awake || event.pointerType !== "mouse" || !target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    ui.play("hover");
  });

  if (!toggle) return;
  show();
  toggle.hidden = false;
  toggle.addEventListener("click", (event) => {
    // The press that woke the page leaves sounds that were on as they were: the button only now shows them.
    if (event !== woke || !ui.isEnabled()) ui.setEnabled(!ui.isEnabled());
    show();
    ui.play("toggle-on");
  });
}
