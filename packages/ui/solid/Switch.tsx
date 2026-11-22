import "../css/switch.css";

/** An on/off toggle (role switch): a track with a thumb that slides to the end when on. `label` names it for screen readers. */
/** `unset`: the value shown is a default, nothing chose it; drawn fainter. */
export function Switch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; unset?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      id={props.id}
      aria-label={props.label}
      aria-checked={props.checked ? "true" : "false"}
      data-unset={props.unset ? "" : undefined}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="thumb" aria-hidden="true" />
    </button>
  );
}
