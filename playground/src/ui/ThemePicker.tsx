import { For, createSignal, onSettled } from "solid-js";
import type { ColorMode } from "@pierre/theming";
import { FAMILIES, familyOf, pickFamily, setColorMode, switchTheme, themeState, watchTheme } from "../theme";

const MODES: [ColorMode, string, string][] = [
  ["system", "i-lucide-monitor", "System"],
  ["light", "i-lucide-sun", "Light"],
  ["dark", "i-lucide-moon", "Dark"],
];

/** A system/light/dark toggle and the theme families. */
export function ThemePicker() {
  // A plain signal, not an async `from()` stream: picking a family sets the light and dark halves in turn, and
  // as a stream those updates could leave the select blank. Both writes land in one batch here.
  const [theme, setTheme] = createSignal(themeState());
  onSettled(() => watchTheme((s) => setTheme({ ...s })));
  return (
    <>
      <span id="modes" role="group" aria-label="Color scheme">
        <For each={MODES}>
          {([mode, icon, label]) => (
            <button
              type="button"
              title={`${label} color scheme`}
              aria-label={`${label} color scheme`}
              aria-pressed={theme().mode === mode ? "true" : "false"}
              onClick={(e) => switchTheme(() => setColorMode(mode), e.currentTarget)}
            >
              <i class={icon} aria-hidden="true" />
            </button>
          )}
        </For>
      </span>
      <select
        id="theme"
        title="Theme"
        value={familyOf(theme())}
        onChange={(e) => {
          const select = e.currentTarget;
          switchTheme(() => pickFamily(select.value), select);
        }}
      >
        <For each={Object.entries(FAMILIES)}>
          {([label, list]) => (
            <optgroup label={label}>
              <For each={list}>{([name, light]) => <option value={light}>{name}</option>}</For>
            </optgroup>
          )}
        </For>
      </select>
    </>
  );
}
