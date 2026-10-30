import { omit } from "solid-js";
import type { JSX, ValidComponent } from "@solidjs/web";
import { Tooltip } from "@kobalte/core/tooltip";

type TipProps = {
  /** What the tooltip says. */
  tip: JSX.Element;
  /** Shortcuts for the action, shown after the text as keys. */
  keys?: string[];
  /** The trigger element (a button unless given). */
  as?: ValidComponent;
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end";
  children?: JSX.Element;
  [attribute: string]: unknown;
};

/** A control with a tooltip that shows on hover and focus (instead of the browser's `title`), after a short delay. */
export function Tip(props: TipProps) {
  const rest = omit(props, "tip", "keys", "as", "placement", "children");
  return (
    <Tooltip placement={props.placement ?? "top"} gutter={6} openDelay={400} closeDelay={0}>
      <Tooltip.Trigger as={(props.as ?? "button") as "button"} {...(rest as JSX.HTMLAttributes<HTMLButtonElement>)}>
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
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
