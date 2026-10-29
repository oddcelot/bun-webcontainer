import { For, createSignal, onSettled } from "solid-js";
import { Select } from "@kobalte/core/select";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import type { ColorMode } from "@pierre/theming";
import { FAMILIES, familyOf, pickFamily, setColorMode, switchTheme, themeState, watchTheme } from "../theme";
import { SWATCHES } from "../themeSwatches";

const MODES: [ColorMode, string, string][] = [
  ["system", "i-lucide-monitor", "System"],
  ["light", "i-lucide-sun", "Light"],
  ["dark", "i-lucide-moon", "Dark"],
];

type Family = { name: string; light: string; dark: string };
type Group = { label: string; options: Family[] };
const GROUPS: Group[] = Object.entries(FAMILIES).map(([label, list]) => ({
  label,
  options: list.map(([name, light, dark]) => ({ name, light, dark })),
}));
const ALL = GROUPS.flatMap((g) => g.options);

/** A family's light and dark halves side by side: background with a strip of the accent along the bottom. */
function Swatch(props: { light: string }) {
  return (
    <span class="swatch" aria-hidden="true">
      <For each={[SWATCHES[props.light]?.light, SWATCHES[props.light]?.dark]}>
        {(c) => <span style={{ background: c?.[0], "--swatch-accent": c?.[2] }} />}
      </For>
    </span>
  );
}

/** A system/light/dark toggle and the theme families. */
export function ThemePicker() {
  // A plain signal, not an async `from()` stream: picking a family sets the light and dark halves in turn, and
  // as a stream those updates could leave the select blank. Both writes land in one batch here.
  const [theme, setTheme] = createSignal(themeState());
  onSettled(() => watchTheme((s) => setTheme({ ...s })));
  const current = () => ALL.find((f) => f.light === familyOf(theme())) ?? null;
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
      <Select<Family, Group>
        options={GROUPS}
        optionValue="light"
        optionTextValue="name"
        optionGroupChildren="options"
        value={current()}
        onChange={(f) => f && switchTheme(() => pickFamily(f.light))}
        placement="bottom-end"
        gutter={6}
        itemComponent={(p) => (
          <Select.Item item={p.item} class="theme-option">
            <Swatch light={p.item.rawValue.light} />
            <Select.ItemLabel class="name">{p.item.rawValue.name}</Select.ItemLabel>
            <Select.ItemIndicator class="check">
              <i class="i-lucide-check" aria-hidden="true" />
            </Select.ItemIndicator>
          </Select.Item>
        )}
        sectionComponent={(p) => <Select.Section class="theme-section">{p.section.rawValue.label}</Select.Section>}
      >
        <Select.Trigger id="theme" title="Theme" aria-label="Theme">
          <Select.Value<Family> class="value">
            {(state) => (
              <>
                <Swatch light={state.selectedOption().light} />
                <span class="name">{state.selectedOption().name}</span>
              </>
            )}
          </Select.Value>
          <Select.Icon class="chevron">
            <i class="i-lucide-chevron-down" aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content class="theme-menu">
            <Select.Listbox class="theme-list" />
          </Select.Content>
        </Select.Portal>
      </Select>
    </>
  );
}
