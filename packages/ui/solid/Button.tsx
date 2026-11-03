import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import "../css/button.css";

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** The main action of its group (a dialog's submit): accent-tinted. */
  primary?: boolean;
};

/** A control-height button. `type` defaults to "button" (not the browser's "submit"); pass "submit" in a form. */
export function Button(props: ButtonProps) {
  const rest = omit(props, "primary", "class", "type");
  return <button type={props.type ?? "button"} class={["button", { primary: props.primary }, props.class]} {...rest} />;
}
