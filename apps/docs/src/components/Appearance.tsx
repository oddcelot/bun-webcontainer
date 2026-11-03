import { createSignal, onSettled } from "solid-js";
import { AppearancePicker, type Mode } from "@runbun/ui/solid/AppearancePicker";
import { DEFAULT_FAMILY } from "@runbun/ui/uno.preset";

// The shared appearance picker (@runbun/ui) over the docs' look: the scheme is Starlight's (`starlight-theme` in
// localStorage, empty for "system"; `data-theme` on <html>), the family `data-family` (`docs-family`), which
// ThemeProvider.astro applies before the first paint and turns into `data-code-theme`.

const SCHEME_KEY = "starlight-theme"; // Starlight's
const FAMILY_KEY = "docs-family";
/** Dispatched on the document after the scheme or family changes, so every picker on the page shows it. */
const CHANGED = "docs-appearance";

const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const storedMode = (): Mode => {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};
const preferred = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
const html = () => document.documentElement;

function setMode(next: Mode) {
  store(SCHEME_KEY, next === "system" ? "" : next);
  html().dataset.theme = next === "system" ? preferred() : next;
  document.dispatchEvent(new Event(CHANGED));
}
/** Shows a family on the page (code blocks and embeds follow `data-family`); only a pick remembers it. */
function preview(light: string) {
  html().dataset.family = light;
  document.dispatchEvent(new Event(CHANGED));
}

let watchingScheme = false;

/**
 * One picker. Starlight renders two (header and mobile menu), each an island. Each keeps its own copy of the state:
 * it hydrates over the server's markup (the defaults) unchanged, so the page's real state is read only once the
 * island is hydrated, and again on every change. (A state shared by both islands reached only the one hydrated before
 * it changed.)
 */
export default function Appearance() {
  const [mode, setModeSignal] = createSignal<Mode>("system");
  const [family, setFamily] = createSignal(DEFAULT_FAMILY);
  const read = () => {
    setModeSignal(storedMode());
    setFamily(html().dataset.family ?? DEFAULT_FAMILY);
  };
  onSettled(() => {
    queueMicrotask(read);
    document.addEventListener(CHANGED, read);
    if (!watchingScheme) {
      watchingScheme = true;
      matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => storedMode() === "system" && setMode("system"));
    }
    return () => document.removeEventListener(CHANGED, read);
  });
  return (
    <AppearancePicker
      mode={mode()}
      family={family()}
      setMode={setMode}
      preview={preview}
      pick={(light) => {
        store(FAMILY_KEY, light);
        preview(light);
      }}
    />
  );
}
