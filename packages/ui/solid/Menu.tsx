import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import "../css/select.css";
import "../css/menu.css";

/** The button that opens a `Menu`. Pass it as `as` to `Tip` for a tooltip (`<Tip as={MenuTrigger} ...>`), or use it directly. */
export const MenuTrigger = DropdownMenu.Trigger;

type MenuProps = {
  /** The trigger, rendered inside the menu's root so it opens and labels the menu. */
  trigger: JSX.Element;
  placement?: "bottom-start" | "bottom-end" | "bottom" | "top-start" | "top-end" | "top";
  /** Extra class for the menu panel, after the shared `select-menu menu`. */
  class?: string;
  /** Items, groups and separators. */
  children?: JSX.Element;
};

/** A dropdown menu: the trigger plus a panel, portaled out of the layout, styled like the select menus. */
export function Menu(props: MenuProps) {
  return (
    <DropdownMenu placement={props.placement} gutter={6}>
      {props.trigger}
      <DropdownMenu.Portal>
        <DropdownMenu.Content class={props.class ? `select-menu menu ${props.class}` : "select-menu menu"}>{props.children}</DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}

type ItemProps = {
  /** Leading icon: an icon class (`i-lucide-...`), or an element for anything else (an image). */
  icon?: string | JSX.Element;
  label: JSX.Element;
  disabled?: boolean;
  onSelect?: () => void;
  /**
   * Close the menu after selecting; false keeps it open (toggles). Passed as `true` when unset: Solid 2's `merge`
   * takes an `undefined` over Kobalte's default, which would keep every menu open.
   */
  closeOnSelect?: boolean;
  /** Trailing content, after the label. */
  children?: JSX.Element;
};

/** An action row: optional icon, the label, then any trailing content. */
export function MenuItem(props: ItemProps) {
  return (
    <DropdownMenu.Item class="select-option" disabled={props.disabled} closeOnSelect={props.closeOnSelect ?? true} onSelect={props.onSelect}>
      <Show when={typeof props.icon === "string" ? (props.icon as string) : undefined} fallback={props.icon}>
        {(icon) => <i class={icon()} aria-hidden="true" />}
      </Show>
      <DropdownMenu.ItemLabel class="name">{props.label}</DropdownMenu.ItemLabel>
      {props.children}
    </DropdownMenu.Item>
  );
}

type CheckItemProps = Omit<ItemProps, "icon" | "closeOnSelect"> & {
  checked: boolean;
};

/** A toggle row: a check column (marked while `checked`) instead of an icon. It keeps the menu open, so several can be flipped in a row. */
export function MenuCheckItem(props: CheckItemProps) {
  return (
    <DropdownMenu.Item class="select-option" closeOnSelect={false} disabled={props.disabled} onSelect={props.onSelect}>
      <span class="check" aria-hidden="true">
        <Show when={props.checked}>
          <i class="i-lucide-check" />
        </Show>
      </span>
      <DropdownMenu.ItemLabel class="name">{props.label}</DropdownMenu.ItemLabel>
      {props.children}
    </DropdownMenu.Item>
  );
}

/** A labelled group of rows. */
export function MenuGroup(props: { label: JSX.Element; children?: JSX.Element }) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.GroupLabel class="select-section">{props.label}</DropdownMenu.GroupLabel>
      {props.children}
    </DropdownMenu.Group>
  );
}

/** A divider between sets of rows. */
export function MenuSeparator() {
  return <DropdownMenu.Separator class="separator" />;
}
