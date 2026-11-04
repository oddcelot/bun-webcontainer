import { Show, type ComponentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Select as Kobalte } from "@kobalte/core/select";
import { Tip } from "./Tip";
import "../css/select.css";

type SelectProps<T, G> = {
  /** The choices: a flat list, or sections when `groupChildren` names the key holding each section's choices. */
  options: T[] | G[];
  /** The key of a choice that identifies it, and the key that's its text (typeahead, screen readers). Unneeded for strings. */
  optionValue?: string;
  optionTextValue?: string;
  /** Set for sections: the key of a section holding its choices. A section's `label` is its heading. */
  groupChildren?: string;
  /** The chosen choice. Controlled: the select shows this whatever is picked until it changes. */
  value: T | null;
  onChange: (choice: T | null) => void;
  /** The trigger's accessible name, and its `id`, class and tooltip (none, no tooltip). */
  label: string;
  id?: string;
  class?: string;
  tip?: JSX.Element;
  disabled?: boolean;
  /** A choice can't be cleared by picking it again. */
  required?: boolean;
  /** Extra class on the popup, for a menu that needs its own look. */
  menuClass?: string;
  placement?: ComponentProps<typeof Kobalte>["placement"];
  gutter?: number;
  /** What a choice reads as, in the menu and in the trigger (its text value unless given). */
  text?: (choice: T) => JSX.Element;
  /** Something before a choice's text, in the menu and in the trigger: a swatch, an icon. */
  leading?: (choice: T) => JSX.Element;
  /** The choice the pointer or the arrow keys are on while the menu is open; null once it closes. */
  onHighlight?: (choice: T | null) => void;
};

/**
 * A button that opens a menu of choices (Kobalte's Select). Pass a stable list: changing a mounted Select's options
 * logs STRICT_READ_UNTRACKED from inside Kobalte, so remount it (`<Show keyed>`) instead.
 */
export function Select<T, G extends { label: string } = { label: string; options: T[] }>(props: SelectProps<T, G>) {
  // Kobalte has no highlight event: watch its `data-highlighted` on the items, mapped back to their choices by `data-key`.
  const items = new Map<string, T>();
  let watching: MutationObserver | undefined;
  const highlighted = (menu: HTMLElement) => {
    const el = menu.querySelector("[data-highlighted]");
    props.onHighlight?.(items.get(el?.getAttribute("data-key") ?? "") ?? null);
  };
  const watch = (menu: HTMLElement) => {
    if (!props.onHighlight) return;
    watching?.disconnect();
    watching = new MutationObserver(() => highlighted(menu));
    watching.observe(menu, { subtree: true, attributeFilter: ["data-highlighted"] });
    queueMicrotask(() => highlighted(menu));
  };
  const text = (choice: T) => (props.text ? props.text(choice) : String((choice as Record<string, unknown>)[props.optionTextValue ?? ""] ?? choice));
  return (
    <Kobalte<T, G>
      options={props.options as T[]}
      optionValue={props.optionValue as never}
      optionTextValue={props.optionTextValue as never}
      optionGroupChildren={props.groupChildren as never}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      disallowEmptySelection={props.required}
      placement={props.placement}
      gutter={props.gutter ?? 6}
      onOpenChange={(open) => {
        if (open) return;
        watching?.disconnect();
        watching = undefined;
        props.onHighlight?.(null);
      }}
      itemComponent={(p) => (
        void items.set(p.item.key, p.item.rawValue),
        <Kobalte.Item item={p.item} class="select-option">
          {props.leading?.(p.item.rawValue)}
          <Kobalte.ItemLabel class="name">{text(p.item.rawValue)}</Kobalte.ItemLabel>
          <Kobalte.ItemIndicator class="check">
            <i class="i-lucide-check" aria-hidden="true" />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      sectionComponent={(p) => <Kobalte.Section class="select-section">{p.section.rawValue.label}</Kobalte.Section>}
    >
      <Tip as={Kobalte.Trigger} id={props.id} class={["select-trigger", props.class]} tip={props.tip} aria-label={props.label}>
        <Kobalte.Value<T> class="value">
          {(state) => (
            <>
              {props.leading?.(state.selectedOption())}
              <span class="name">{text(state.selectedOption())}</span>
            </>
          )}
        </Kobalte.Value>
        <Kobalte.Icon class="chevron">
          <i class="i-lucide-chevron-down" aria-hidden="true" />
        </Kobalte.Icon>
      </Tip>
      <Kobalte.Portal>
        <Kobalte.Content class={["select-menu", props.menuClass]} ref={watch}>
          <Kobalte.Listbox class="select-list" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  );
}
