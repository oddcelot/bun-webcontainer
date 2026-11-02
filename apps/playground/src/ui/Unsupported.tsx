import { For, Show } from "solid-js";
import { engineHint, type Check } from "../support";

/**
 * A banner above the editor saying what's missing: editing, examples and sharing still work, but nothing can run
 * (the module server and the program need Bun's wasm, a service worker and module workers).
 */
export function Unsupported(props: { checks: Check[] }) {
  const missing = () => props.checks.filter((c) => !c.ok).map((c) => c.name);
  return (
    <details class="unsupported">
      <summary>
        <strong>This browser can't run code here</strong> (missing: {missing().join(", ")}). You can still edit files, open examples and share
        links.
      </summary>
      <ul>
        <For each={props.checks}>
          {(c) => (
            <li data-ok={String(c.ok)}>
              <strong>
                {c.ok ? "✓" : "✗"} {c.name}
              </strong>
              <Show when={!c.ok}>
                {" "}
                <span>{c.why}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={engineHint(props.checks)}>{(hint) => <p>{hint()}</p>}</Show>
      <p class="ua">{navigator.userAgent}</p>
    </details>
  );
}
