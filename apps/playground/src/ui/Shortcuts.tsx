import { For, Show, createSignal, createUniqueId } from "solid-js";
import { Dialog, useDialogContext } from "@kobalte/core/dialog";
import { chordKeys, keysFor, overridesText, setOverrides, COMMANDS, type Command } from "../keymap";
import { Tip } from "./Tip";

/**
 * The keyboard shortcuts in effect, and the JSON that changes them: command names to a chord, a list of chords, or
 * null to unbind. Kept in this browser, for every project. Its button is in the header and in the status bar.
 */
export function Shortcuts(props: { id?: string; placement?: "top" | "bottom" }) {
  return (
    <Dialog>
      <Tip as={Dialog.Trigger} id={props.id} placement={props.placement} tip="Keyboard shortcuts" aria-label="Keyboard shortcuts">
        <i class="i-lucide-keyboard" aria-hidden="true" />
      </Tip>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Dialog.Content class="dialog shortcuts">
            <ShortcutsForm />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

/** The commands by what they act on, in the dialog's order. */
const GROUPS: { title: string; commands: Command[] }[] = [
  { title: "Run", commands: ["run", "stop"] },
  { title: "Files", commands: ["save", "format", "closeTab"] },
  { title: "Code", commands: ["goToDefinition", "showHover", "suggest", "signatureHelp"] },
  { title: "Layout", commands: ["toggleExplorer", "toggleConsole", "togglePreview", "exitFullscreen"] },
];

// Inside Dialog.Content so each opening reads the keymap afresh (the content unmounts on close).
function ShortcutsForm() {
  const dialog = useDialogContext();
  const id = createUniqueId();
  const [error, setError] = createSignal("");
  let input!: HTMLTextAreaElement;
  const initial = overridesText();
  // A command added to COMMANDS but not to GROUPS still shows.
  const grouped = new Set(GROUPS.flatMap((g) => g.commands));
  const other = (Object.keys(COMMANDS) as Command[]).filter((c) => !grouped.has(c));
  const groups = other.length ? [...GROUPS, { title: "Other", commands: other }] : GROUPS;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const problem = setOverrides(input.value);
        if (problem) setError(problem);
        else dialog.close();
      }}
    >
      <Dialog.Title class="dialog-title">Keyboard shortcuts</Dialog.Title>
      <div class="shortcuts-groups">
        <For each={groups}>
          {(g) => (
            <section class="shortcuts-group">
              <h3>{g.title}</h3>
              <dl>
                <For each={g.commands}>
                  {(c) => (
                    <div class="shortcuts-row">
                      <dt>
                        {COMMANDS[c].label}
                        <code>{c}</code>
                      </dt>
                      <dd>
                        <For each={keysFor(c)} fallback={<span class="unbound">none</span>}>
                          {(chord) => (
                            <span class="chord">
                              <For each={chordKeys(chord)}>{(k) => <kbd>{k}</kbd>}</For>
                            </span>
                          )}
                        </For>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
      {/* Open from the start when there are overrides to see. */}
      <details class="shortcuts-custom" open={initial.trim() !== "{}"}>
        <summary>Customize</summary>
        <label class="dialog-label" for={id}>
          JSON of command names to a chord, a list of chords, or <code>null</code> to unbind, e.g.{" "}
          <code>{'{ "run": "Mod+R", "stop": ["Mod+.", "Shift+F5"], "togglePreview": null }'}</code>. <code>Mod</code> is Cmd on macOS,
          Ctrl elsewhere.
        </label>
        <textarea
        ref={input}
          id={id}
          class="dialog-input shortcuts-json"
          spellcheck={false}
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={`${id}-error`}
          value={initial}
          onInput={() => setError("")}
        />
      </details>
      <Show when={error()}>
        <p id={`${id}-error`} class="dialog-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="dialog-actions">
        <Dialog.CloseButton class="dialog-button" type="button">
          Cancel
        </Dialog.CloseButton>
        <button class="dialog-button primary" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}
