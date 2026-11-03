import { Show, onSettled, useContext } from "solid-js";
import { AppContext } from "./context";
import { Tip } from "@runbun/ui/solid/Tip";

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
        <Tip as="span" id="console-count" class="chip" tip="Lines">
          {counts.lines}
        </Tip>
        <Show when={counts.error}>
          <Tip as="span" id="console-errors" class="chip error" tip="Errors">
            <i class="i-lucide-circle-x" aria-hidden="true" />
            <span>{counts.error}</span>
          </Tip>
        </Show>
        <Show when={counts.warn}>
          <Tip as="span" id="console-warns" class="chip warn" tip="Warnings">
            <i class="i-lucide-triangle-alert" aria-hidden="true" />
            <span>{counts.warn}</span>
          </Tip>
        </Show>
        <Tip
          id="clear"
          tip="Clear console"
          aria-label="Clear console"
          disabled={counts.lines === 0}
          onClick={() => {
            app.clearConsole();
            app.terminal.focus();
          }}
        >
          <i class="i-lucide-trash-2" aria-hidden="true" />
        </Tip>
      </div>
      <div id="console" ref={el} />
    </>
  );
}
