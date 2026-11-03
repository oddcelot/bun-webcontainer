import { For, Show } from "solid-js";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import { Tip } from "./Tip";

/** One of a few values, as a row of buttons . */
export function Segmented(props: { label: string; value: string; options: [value: string, label: string, icon?: string, tip?: string][]; onChange: (v: string) => void }) {
  return (
    <ToggleGroup class="segmented" aria-label={props.label} value={props.value} onChange={(v) => v && props.onChange(v)}>
      <For each={props.options}>
        {([value, label, icon, tip]) => (
          <Tip as={ToggleGroup.Item} value={value} tip={tip}>
            <Show when={icon}>
              <i class={icon} aria-hidden="true" />
            </Show>
            {label}
          </Tip>
        )}
      </For>
    </ToggleGroup>
  );
}
