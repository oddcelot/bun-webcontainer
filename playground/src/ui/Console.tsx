import { Show, onSettled, useContext } from "solid-js";
import { AppContext } from "./app";

/** The console pane: its header (line, error and warning counts, Clear) over the terminal. */
export function Console() {
  const app = useContext(AppContext);
  const counts = app.session.counts;
  let el!: HTMLDivElement;
  onSettled(() => app.terminal.attach(el));
  return (
    <>
      <div id="console-head">
        <i class="i-lucide-square-terminal" aria-hidden="true" />
        <span class="label">Console</span>
        <span id="console-count" class="chip" title="Lines">
          {counts.lines}
        </span>
        <Show when={counts.error}>
          <span id="console-errors" class="chip error" title="Errors">
            <i class="i-lucide-circle-x" aria-hidden="true" />
            <span>{counts.error}</span>
          </span>
        </Show>
        <Show when={counts.warn}>
          <span id="console-warns" class="chip warn" title="Warnings">
            <i class="i-lucide-triangle-alert" aria-hidden="true" />
            <span>{counts.warn}</span>
          </span>
        </Show>
        <button
          id="clear"
          title="Clear console"
          aria-label="Clear console"
          disabled={counts.lines === 0}
          onClick={() => {
            app.clearConsole();
            app.terminal.focus();
          }}
        >
          <i class="i-lucide-trash-2" aria-hidden="true" />
        </button>
      </div>
      <div id="console" ref={el} />
    </>
  );
}
