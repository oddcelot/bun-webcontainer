import { Show, type ParentProps } from "solid-js";
import "../css/field.css";

/** A label (and an optional hint after it) over its control, which is the child: clicking the label focuses it. */
export function Field(props: ParentProps<{ label: string; hint?: string; class?: string }>) {
  return (
    <label class={["field", props.class]}>
      <span class="field-label">
        {props.label}
        <Show when={props.hint}>
          <span class="field-hint">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </label>
  );
}
