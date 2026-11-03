import { Listbox } from "@kobalte/core/listbox";
import themes from "../themes.json";
import { Swatch } from "./Swatch";
import "../css/select.css";

/** A theme family: its name and its light and dark themes (themes.json). */
export type Family = { group: string; name: string; light: string; dark: string };
type Group = { label: string; options: Family[] };

export const FAMILIES: Family[] = themes.families;
const GROUPS: Group[] = [...new Set(FAMILIES.map((f) => f.group))].map((label) => ({
  label,
  options: FAMILIES.filter((f) => f.group === label),
}));

/**
 * The theme families as a grouped list, each with its swatch. `value` is the selected family (by its light theme);
 * `onFocusFamily` runs when the pointer or keyboard focus reaches one (to preview it), `onPick` when one is chosen.
 */
export function FamilyListbox(props: {
  value: string;
  onPick: (light: string) => void;
  onFocusFamily?: (light: string) => void;
  onPointerLeave?: () => void;
  onEscape?: () => void;
}) {
  return (
    <Listbox<Family, Group>
      class="select-list"
      aria-label="Theme"
      options={GROUPS}
      optionValue="light"
      optionTextValue="name"
      optionGroupChildren="options"
      value={[props.value]}
      onChange={(keys) => {
        const [light] = keys;
        if (light) props.onPick(light);
      }}
      selectionMode="single"
      disallowEmptySelection
      shouldFocusOnHover
      onPointerLeave={() => props.onPointerLeave?.()}
      // The listbox keeps Escape to itself, so a popover around it wouldn't close.
      onKeyDown={(e) => e.key === "Escape" && props.onEscape?.()}
      renderItem={(item) => (
        <Listbox.Item item={item} class="select-option" onFocus={() => props.onFocusFamily?.(item.rawValue.light)}>
          <Swatch light={item.rawValue.light} />
          <Listbox.ItemLabel class="name">{item.rawValue.name}</Listbox.ItemLabel>
          <Listbox.ItemIndicator class="check">
            <i class="i-lucide-check" aria-hidden="true" />
          </Listbox.ItemIndicator>
        </Listbox.Item>
      )}
      renderSection={(section) => <Listbox.Section class="select-section">{section.rawValue.label}</Listbox.Section>}
    />
  );
}
