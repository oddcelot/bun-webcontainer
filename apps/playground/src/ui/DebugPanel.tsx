import { For, Show, createSignal, useContext } from "solid-js";
import { Tip } from "@runbun/ui/solid/Tip";
import { debugSession, type DebugScope } from "../debugSession";
import { AppContext } from "./context";

const SCOPES: Record<DebugScope["kind"], string> = { local: "Local", block: "Block", module: "Module" };

/** Debug-key handling shared with App's shortcuts: F8 resume, F10 over, F11 into, Shift+F11 out. Returns whether it ran one. */
export function debugKey(e: KeyboardEvent): boolean {
  if (!debugSession.paused() || e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key === "F8") debugSession.resume();
  else if (e.key === "F10") debugSession.stepOver();
  else if (e.key === "F11") (e.shiftKey ? debugSession.stepOut : debugSession.stepInto)();
  else return false;
  return true;
}

/** The debugger pane, above the console while Debug is on: step buttons, call stack, variables of the paused frame, and an evaluate box. */
export function DebugPanel() {
  const app = useContext(AppContext);
  const [results, setResults] = createSignal<{ expr: string; ok: boolean; result: string }[]>([]);
  const paused = debugSession.paused;
  const status = () => {
    const p = paused();
    if (p) return `Paused on ${p.reason === "breakpoint" ? "breakpoint" : p.reason} at ${p.path}:${p.line + 1}`;
    return debugSession.attached() ? "Running" : "Press Run to debug";
  };
  const step = (icon: string, tip: string, key: string, run: () => unknown) => (
    <Tip class="step" tip={tip} keys={[key]} aria-label={tip} disabled={!paused()} onClick={run}>
      <i class={icon} aria-hidden="true" />
    </Tip>
  );
  return (
    <div id="debug-panel">
      <div class="head">
        <i class="i-lucide-bug" aria-hidden="true" />
        <span class="label">Debug</span>
        {step("i-lucide-play", "Resume", "F8", debugSession.resume)}
        {step("i-lucide-step-forward", "Step over", "F10", debugSession.stepOver)}
        {step("i-lucide-arrow-down-to-line", "Step into", "F11", debugSession.stepInto)}
        {step("i-lucide-arrow-up-from-line", "Step out", "⇧F11", debugSession.stepOut)}
        <span class="status" data-paused={paused() ? "" : undefined}>
          {status()}
        </span>
      </div>
      <div class="body">
        <section class="stack">
          <h3>Call stack</h3>
          <Show when={paused()} fallback={<p class="empty">Not paused</p>}>
            <ul>
              <For each={paused()!.frames}>
                {(f) => (
                  <li>
                    <button type="button" onClick={() => app.workspace.openAt(f.path, f.line + 1, f.column + 1)}>
                      <span class="name">{f.name || "(module)"}</span>
                      <span class="at">
                        {f.path}:{f.line + 1}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <section class="vars">
          <h3>Variables</h3>
          <Show when={paused()} fallback={<p class="empty">Not paused</p>}>
            <For each={paused()!.scopes}>
              {(s) => (
                <div class="scope">
                  <h4>{SCOPES[s.kind]}</h4>
                  <For each={s.vars} fallback={<p class="empty">(none)</p>}>
                    {(v) => (
                      <div class="var">
                        <span class="name">{v.name}</span>
                        <span class="value">{v.value}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </section>
        <section class="eval">
          <h3>Evaluate</h3>
          <input
            type="text"
            spellcheck={false}
            autocomplete="off"
            placeholder={paused() ? "Expression, Enter to evaluate" : "Pause to evaluate"}
            disabled={!paused()}
            onKeyDown={async (e) => {
              const input = e.currentTarget;
              if (e.key !== "Enter" || !input.value.trim()) return;
              const expr = input.value;
              input.value = "";
              const r = await debugSession.evaluate(expr);
              setResults((list) => [{ expr, ...r }, ...list].slice(0, 50));
            }}
          />
          <For each={results()}>
            {(r) => (
              <div class="result" data-error={r.ok ? undefined : ""}>
                <span class="expr">{r.expr}</span>
                <span class="value">{r.result}</span>
              </div>
            )}
          </For>
        </section>
      </div>
    </div>
  );
}
