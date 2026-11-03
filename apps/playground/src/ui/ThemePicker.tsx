import { For, createSignal, onSettled } from "solid-js";
import { Listbox } from "@kobalte/core/listbox";
import { Popover } from "@kobalte/core/popover";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import type { ColorMode } from "@pierre/theming";
import { FAMILIES, familyOf, pickFamily, setColorMode, switchTheme, themeState, watchTheme } from "../theme";
import { setStatusDisplay, statusDisplay } from "./StatusBar";
import { Swatch } from "@runbun/ui/solid/Swatch";
import { Tip } from "@runbun/ui/solid/Tip";

const MODES: [ColorMode, string, string][] = [
  ["system", "i-lucide-monitor", "System"],
  ["light", "i-lucide-sun", "Light"],
  ["dark", "i-lucide-moon", "Dark"],
];
const STATUS: ["bar" | "toast", string, string, string][] = [
  ["bar", "i-lucide-panel-bottom", "Status pill", "The run status as a pill in the status bar"],
  ["toast", "i-lucide-message-square", "Status toast", "The run status as a toast over the panes that fades once it settles"],
];

type Family = { name: string; light: string; dark: string };
type Group = { label: string; options: Family[] };
const GROUPS: Group[] = Object.entries(FAMILIES).map(([label, list]) => ({
  label,
  options: list.map(([name, light, dark]) => ({ name, light, dark })),
}));
const ALL = GROUPS.flatMap((g) => g.options);

/**
 * Appearance: a swatch button opening the system/light/dark toggle over the theme families, then where the run status
 * shows. A family under the pointer or keyboard focus previews at once (theme.ts preloads them all); clicking one keeps
 * it, and closing the popover or moving the pointer off the list without one puts the kept family back.
 */
export function ThemePicker() {
  // A plain signal, not an async `from()` stream: picking a family sets the light and dark halves in turn, and
  // as a stream those updates could leave the picker blank. Both writes land in one batch here.
  const [theme, setTheme] = createSignal(themeState());
  onSettled(() => watchTheme((s) => setTheme({ ...s })));
  const current = () => ALL.find((f) => f.light === familyOf(theme())) ?? ALL[0];

  // The family a preview falls back to: the one shown when the popover opened, or the last one clicked.
  // Set whenever the popover opens; nothing reads it before then.
  const [kept, setKept] = createSignal("");
  const restore = () => familyOf(themeState()) !== kept() && pickFamily(kept());
  const [open, setOpen] = createSignal(false);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setKept(current().light);
    else restore();
  };

  return (
    <Popover placement="bottom-end" gutter={6} open={open()} onOpenChange={onOpenChange}>
      <Tip as={Popover.Trigger} id="theme" class="select-trigger" placement="bottom-end" tip={`Appearance: ${current().name}, ${theme().mode}`} aria-label="Appearance">
        <Swatch light={current().light} />
        <i class={MODES.find(([m]) => m === theme().mode)?.[1]} aria-hidden="true" />
        <i class="chevron i-lucide-chevron-down" aria-hidden="true" />
      </Tip>
      <Popover.Portal>
        <Popover.Content class="appearance">
          {/* One mode is always on: clicking the pressed one again (onChange(null)) changes nothing. */}
          <ToggleGroup
            id="modes"
            class="segmented"
            aria-label="Color scheme"
            value={theme().mode}
            onChange={(mode) => mode && switchTheme(() => setColorMode(mode as ColorMode))}
          >
            <For each={MODES}>
              {([mode, icon, label]) => (
                <ToggleGroup.Item value={mode} title={`${label} color scheme`}>
                  <i class={icon} aria-hidden="true" />
                  {label}
                </ToggleGroup.Item>
              )}
            </For>
          </ToggleGroup>
          <Listbox<Family, Group>
            class="select-list"
            aria-label="Theme"
            options={GROUPS}
            optionValue="light"
            optionTextValue="name"
            optionGroupChildren="options"
            value={[kept()]}
            onChange={(keys) => {
              const [light] = keys;
              if (!light) return;
              setKept(light);
              pickFamily(light); // previewed already, unless picked from the keyboard without moving focus
            }}
            selectionMode="single"
            disallowEmptySelection
            shouldFocusOnHover
            onPointerLeave={restore}
            // The listbox keeps Escape to itself, so the popover wouldn't close.
            onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
            renderItem={(item) => (
              <Listbox.Item item={item} class="select-option" onFocus={() => pickFamily(item.rawValue.light)}>
                <Swatch light={item.rawValue.light} />
                <Listbox.ItemLabel class="name">{item.rawValue.name}</Listbox.ItemLabel>
                <Listbox.ItemIndicator class="check">
                  <i class="i-lucide-check" aria-hidden="true" />
                </Listbox.ItemIndicator>
              </Listbox.Item>
            )}
            renderSection={(section) => <Listbox.Section class="select-section">{section.rawValue.label}</Listbox.Section>}
          />
          <ToggleGroup id="status-display" class="segmented" aria-label="Run status" value={statusDisplay()} onChange={(v) => v && setStatusDisplay(v as "bar" | "toast")}>
            <For each={STATUS}>
              {([value, icon, label, title]) => (
                <ToggleGroup.Item value={value} title={title}>
                  <i class={icon} aria-hidden="true" />
                  {label}
                </ToggleGroup.Item>
              )}
            </For>
          </ToggleGroup>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
