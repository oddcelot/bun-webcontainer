import { Show, onSettled, useContext } from "solid-js";
import { AppContext } from "./context";
import type { DockTab } from "./dockTab";
import { Tip } from "@runbun/ui/solid/Tip";

/** The console in the dock's header: line, error and warning counts, Clear. */
function ConsoleHead() {
  const app = useContext(AppContext);
  const counts = app.session.counts;
  return (
    <>
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
    </>
  );
}

/** The terminal. */
function ConsoleBody() {
  const app = useContext(AppContext);
  let el!: HTMLDivElement;
  onSettled(() => app.terminal.attach(el));
  return <div id="console" ref={el} />;
}

export const consoleTab: DockTab = { id: "console", title: "Console", tip: "What the program prints, and a shell", icon: "i-lucide-square-terminal", // Each failed run settles on a new status, so each one brings the console forward: its output says why.
  attention: (app) => (app.session.settled().state === "error" ? app.session.settled() : undefined),
  Head: ConsoleHead, Body: ConsoleBody };
