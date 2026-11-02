import { For } from "solid-js";
import { SWATCHES } from "../themeSwatches";

/** A family's light and dark halves side by side: background with a strip of the accent along the bottom. */
export function Swatch(props: { light: string }) {
  return (
    <span class="swatch" aria-hidden="true">
      <For each={[SWATCHES[props.light]?.light, SWATCHES[props.light]?.dark]}>
        {(c) => <span style={{ background: c?.[0], "--swatch-accent": c?.[2] }} />}
      </For>
    </span>
  );
}
