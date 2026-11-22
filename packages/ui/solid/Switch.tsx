import "../css/switch.css";

/** An on/off toggle (role switch): a track with a thumb that slides to the end when on. `label` names it for screen readers. */
export function Switch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      id={props.id}
      aria-label={props.label}
      aria-checked={props.checked ? "true" : "false"}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="thumb" aria-hidden="true" />
    </button>
  );
}
