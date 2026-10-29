import { For, createSignal, onSettled } from "solid-js";
import { ToggleGroup } from "@kobalte/core/toggle-group";
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
      {/* One mode is always on: clicking the pressed one again (onChange(null)) changes nothing. */}
      <ToggleGroup
        as="span"
        id="modes"
        aria-label="Color scheme"
        value={theme().mode}
        onChange={(mode) => mode && switchTheme(() => setColorMode(mode as ColorMode))}
      >
        <For each={MODES}>
          {([mode, icon, label]) => (
            <ToggleGroup.Item value={mode} title={`${label} color scheme`} aria-label={`${label} color scheme`}>
              <i class={icon} aria-hidden="true" />
            </ToggleGroup.Item>
          )}
        </For>
      </ToggleGroup>
      <select
        id="theme"
        title="Theme"
        value={familyOf(theme())}
        onChange={(e) => {
          const light = e.currentTarget.value;
          switchTheme(() => pickFamily(light));
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
