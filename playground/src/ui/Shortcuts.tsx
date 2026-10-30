import { For, createSignal, createUniqueId } from "solid-js";
import { Dialog, useDialogContext } from "@kobalte/core/dialog";
import { COMMANDS, formatChord, keysFor, overridesText, setOverrides, type Command } from "../keymap";

/**
 * The keyboard shortcuts in effect, and the JSON that changes them: command names to a chord, a list of chords, or
 * null to unbind. Kept in this browser, for every project.
 */
export function Shortcuts() {
  return (
    <Dialog>
      <Dialog.Trigger id="shortcuts" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
        <i class="i-lucide-keyboard" aria-hidden="true" />
      </Dialog.Trigger>
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

// Inside Dialog.Content so each opening reads the keymap afresh (the content unmounts on close).
function ShortcutsForm() {
  const dialog = useDialogContext();
  const id = createUniqueId();
  const [error, setError] = createSignal("");
  let input!: HTMLTextAreaElement;
  const commands = Object.keys(COMMANDS) as Command[];
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
      <table class="shortcuts-table">
        <tbody>
          <For each={commands}>
            {(c) => (
              <tr>
                <td>
                  {COMMANDS[c].label} <code>{c}</code>
                </td>
                <td>
                  <For each={keysFor(c)} fallback={<span class="unbound">none</span>}>
                    {(k) => <kbd>{formatChord(k)}</kbd>}
                  </For>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <label class="dialog-label" for={id}>
        Overrides, e.g. <code>{'{ "run": "Mod+R", "stop": ["Mod+.", "Shift+F5"], "togglePreview": null }'}</code>
      </label>
      <textarea
        ref={input}
        id={id}
        class="dialog-input shortcuts-json"
        spellcheck={false}
        aria-invalid={error() ? "true" : undefined}
        aria-describedby={`${id}-error`}
        value={overridesText()}
        onInput={() => setError("")}
      />
      <p id={`${id}-error`} class="dialog-error" role="alert">
        {error()}
      </p>
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
