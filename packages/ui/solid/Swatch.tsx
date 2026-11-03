import { For } from "solid-js";
import themes from "../themes.json";

const chrome: Record<string, Record<string, string>> = themes.chrome;
const darkOf: Record<string, string> = Object.fromEntries(themes.families.map((f) => [f.light, f.dark]));

/** A family's light and dark halves side by side: background with a strip of the accent along the bottom. */
export function Swatch(props: { light: string }) {
  return (
    <span class="swatch" aria-hidden="true">
      <For each={[chrome[props.light], chrome[darkOf[props.light] ?? ""]]}>
        {(c) => <span style={{ background: c?.["--bg"], "--swatch-accent": c?.["--accent"] }} />}
      </For>
    </span>
  );
}
