import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import "../css/input.css";

/** A one-line text field (or, with `multiline`, a textarea) in the controls' look. Other props go to the element. */
export function Input(
  props: (JSX.InputHTMLAttributes<HTMLInputElement> & { multiline?: false }) | (JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { multiline: true }),
) {
  const rest = omit(props, "multiline", "class");
  return props.multiline ? (
    <textarea class={["input", props.class]} {...(rest as JSX.TextareaHTMLAttributes<HTMLTextAreaElement>)} />
  ) : (
    <input class={["input", props.class]} {...(rest as JSX.InputHTMLAttributes<HTMLInputElement>)} />
  );
}
