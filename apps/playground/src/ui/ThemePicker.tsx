import { createSignal, onSettled } from "solid-js";
import { AppearancePicker } from "@runbun/ui/solid/AppearancePicker";
import { familyOf, pickFamily, preloadThemes, setColorMode, switchTheme, themeState, watchTheme } from "../theme";

/**
 * The shared appearance picker (@runbun/ui) over the playground's theme. The theme
 * modules load when the pointer or focus first reaches its button (`preloadThemes`), so a preview in the list is instant.
 */
export function ThemePicker() {
  // A plain signal, not an async `from()` stream: picking a family sets the light and dark halves in turn, and
  // as a stream those updates could leave the picker blank. Both writes land in one batch here.
  const [theme, setTheme] = createSignal(themeState());
  onSettled(() => {
    const button = document.getElementById("theme");
    const warm = () => preloadThemes();
    for (const type of ["pointerenter", "focusin", "pointerdown"]) button?.addEventListener(type, warm, { once: true });
    const stop = watchTheme((s) => setTheme({ ...s }));
    return () => {
      stop();
      for (const type of ["pointerenter", "focusin", "pointerdown"]) button?.removeEventListener(type, warm);
    };
  });

  return (
    <AppearancePicker
      id="theme"
      mode={theme().mode}
      family={familyOf(theme()) ?? ""}
      setMode={(mode) => switchTheme(() => setColorMode(mode))}
      preview={pickFamily}
      pick={pickFamily}
    />
  );
}
