import { Show, createSignal, omit } from "solid-js";
import type { JSX, ValidComponent } from "@solidjs/web";
import { Tooltip } from "@kobalte/core/tooltip";
import { topLayerOf } from "./layer";
import "../css/tooltip.css";

type TipProps = {
  /** What the tooltip says; none, no tooltip. */
  tip?: JSX.Element;
  /** Shortcuts for the action, shown after the text: each a chord, as its keys (`["⌥", "⇧", "F"]`) or one key. */
  keys?: (string | string[])[];
  /** The trigger element (a button unless given). */
  as?: ValidComponent;
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end";
  children?: JSX.Element;
  [attribute: string]: unknown;
};

/**
 * macOS's key symbols as Lucide icons, with the key's name for screen readers. Only macOS chords use these symbols
 * (elsewhere a chord reads `Ctrl Shift F`), so the other systems keep their words.
 */
const KEY_ICONS: Record<string, [icon: string, name: string]> = {
  "⌘": ["i-lucide-command", "Command"],
  "⌥": ["i-lucide-option", "Option"],
  "⇧": ["i-lucide-arrow-big-up", "Shift"],
  "⌃": ["i-lucide-chevron-up", "Control"],
  "↵": ["i-lucide-corner-down-left", "Return"],
  "⌫": ["i-lucide-delete", "Delete"],
  // Lucide has no forward delete: Delete's icon, mirrored (tooltip.css).
  "⌦": ["i-lucide-delete mirrored", "Forward Delete"],
  "↑": ["i-lucide-arrow-up", "Up Arrow"],
  "↓": ["i-lucide-arrow-down", "Down Arrow"],
  "←": ["i-lucide-arrow-left", "Left Arrow"],
  "→": ["i-lucide-arrow-right", "Right Arrow"],
};

/** One key cap: an icon for a macOS symbol, else the key as written. */
export function Key(props: { name: string }) {
  const icon = () => KEY_ICONS[props.name];
  return (
    <Show when={icon()} fallback={<kbd>{props.name}</kbd>}>
      {(i) => (
        <kbd class="icon" aria-label={i()[1]} title={i()[1]}>
          <i class={i()[0]} aria-hidden="true" />
        </kbd>
      )}
    </Show>
  );
}

/** Shortcuts as key caps, one `<kbd>` per key: each a chord, as its keys (`["⌥", "⇧", "F"]`) or one key; "or" between chords. */
export function Keys(props: { keys: (string | string[])[] }) {
  return (
    <>
      {props.keys.map((chord) => (
        <span class="chord">
          {(typeof chord === "string" ? [chord] : chord).map((k) => (
            <Key name={k} />
          ))}
        </span>
      ))}
    </>
  );
}

/**
 * A control with a tooltip that shows on hover and keyboard focus (instead of the browser's `title`), after a short
 * delay. Below the control unless given, flipping where there's no room (the status bar's go above). For a Kobalte
 * trigger, pass it as `as` (`<Tip as={Select.Trigger} ...>`): the two triggers' props and handlers merge.
 */
export function Tip(props: TipProps) {
  const rest = omit(props, "tip", "keys", "as", "placement", "children", "ref");
  // The tooltip portals into the top layer its trigger sits in, if any (layer.ts); looked up as it opens.
  let trigger: HTMLElement | undefined;
  const [layer, setLayer] = createSignal<HTMLElement | undefined>();
  return (
    <Tooltip
      placement={props.placement ?? "bottom"}
      gutter={6}
      openDelay={400}
      closeDelay={0}
      disabled={!props.tip}
      onOpenChange={(open) => open && setLayer(topLayerOf(trigger))}
    >
      <Tooltip.Trigger
        as={(props.as ?? "button") as "button"}
        {...(rest as JSX.HTMLAttributes<HTMLButtonElement>)}
        ref={(el: HTMLElement) => {
          trigger = el;
          (props.ref as ((el: HTMLElement) => void) | undefined)?.(el);
        }}
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal mount={layer()}>
        <Tooltip.Content class="tooltip">
          {props.tip}
          <Show when={props.keys}>{(keys) => <Keys keys={keys()} />}</Show>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}
