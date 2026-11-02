import { createEffect, createSignal, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Status } from "./session";

/** The program's status as a pill: a dot colored by state, then the text. */
export function StatusPill(props: JSX.HTMLAttributes<HTMLSpanElement> & { status: Status }) {
  return (
    <span id="status" data-state={props.status.state} {...omit(props, "status")}>
      <span class="text">{props.status.text}</span>
    </span>
  );
}

// How long a status stays up before the toast fades. Busy shows while it lasts and an error until the next change.
const LINGER: Partial<Record<Status["state"], number>> = { running: 3000, idle: 3000 };

/**
 * The status as a toast over the panes' bottom-right corner instead of the bar's pill: each change shows it, and a
 * settled one fades after a moment. It stays mounted (hidden by CSS) so screen readers still hear each change.
 */
export function StatusToast(props: { status: Status }) {
  const [hidden, setHidden] = createSignal(false);
  createEffect(
    () => props.status,
    (status) => {
      setHidden(false);
      const ms = LINGER[status.state];
      if (ms === undefined) return;
      const timer = setTimeout(() => setHidden(true), ms);
      return () => clearTimeout(timer);
    },
  );
  return <StatusPill class="toast" role="status" status={props.status} data-hidden={hidden() ? "" : undefined} />;
}
