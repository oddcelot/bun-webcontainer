import type { ParentProps } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import { Tip } from "./Tip";
import "../css/chips.css";

/** Any number of values, as a wrapping row of small toggles (`Chip`s). A chip is pressed while its value is in `value`. */
export function Chips(props: ParentProps<{ label: string; value: string[]; onChange: (value: string[]) => void }>) {
  return (
    <ToggleGroup class="chips" multiple aria-label={props.label} value={props.value} onChange={(v) => props.onChange(v as string[])}>
      {props.children}
    </ToggleGroup>
  );
}

/** One chip of `Chips`, with a tooltip. */
export function Chip(props: ParentProps<{ value: string; tip?: JSX.Element }>) {
  return (
    <Tip as={ToggleGroup.Item} class="chip" value={props.value} tip={props.tip}>
      {props.children}
    </Tip>
  );
}
