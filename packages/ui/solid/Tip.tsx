import { createSignal, omit } from "solid-js";
import type { JSX, ValidComponent } from "@solidjs/web";
import { Tooltip } from "@kobalte/core/tooltip";
import { topLayerOf } from "./layer";
import "../css/tooltip.css";

type TipProps = {
  /** What the tooltip says; none, no tooltip. */
  tip?: JSX.Element;
  /** Shortcuts for the action, shown after the text as keys. */
  keys?: string[];
  /** The trigger element (a button unless given). */
  as?: ValidComponent;
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end";
  children?: JSX.Element;
  [attribute: string]: unknown;
};

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
          {props.keys?.map((k) => (
            <kbd>{k}</kbd>
          ))}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}
