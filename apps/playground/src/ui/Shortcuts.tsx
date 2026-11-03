import { For, Show, createSignal, createUniqueId, onSettled, untrack } from "solid-js";
import { Dialog, useDialogContext } from "@kobalte/core/dialog";
import { COMMANDS, checkOverrides, chordKeys, chordOf, currentOverrides, keysFor, sameChord, setOverrides, type Command, type Overrides } from "../keymap";
import { Tip } from "@runbun/ui/solid/Tip";

/**
 * The keyboard shortcuts in effect, each one re-recordable (or reset), and the JSON that changes them: command names
 * to a chord, a list of chords, or null to unbind. Kept in this browser, for every project. Its button is in the header.
 */
export function Shortcuts(props: { id?: string }) {
  return (
    <Dialog>
      <Tip as={Dialog.Trigger} id={props.id} tip="Keyboard shortcuts" aria-label="Keyboard shortcuts">
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
  // The overrides as edited here (recorded keys and valid JSON alike); Save keeps them, Cancel drops them.
  // What's in effect as the dialog opens (read once: another tab's change mustn't reset the edits).
  const start = untrack(currentOverrides);
  const [draft, setDraft] = createSignal<Overrides>(start);
  // The command whose keys the next key press sets.
  const [recording, setRecording] = createSignal<Command | null>(null);
  let input!: HTMLTextAreaElement;
  const text = (o: Overrides) => JSON.stringify(o, null, 2);
  const initial = text(start);
  // A command added to COMMANDS but not to GROUPS still shows.
  const grouped = new Set(GROUPS.flatMap((g) => g.commands));
  const other = (Object.keys(COMMANDS) as Command[]).filter((c) => !grouped.has(c));
  const groups = other.length ? [...GROUPS, { title: "Other", commands: other }] : GROUPS;
  const all = groups.flatMap((g) => g.commands);

  /** Sets `command`'s keys (undefined: back to the default), in the draft and the JSON. */
  function bind(command: Command, keys: string | null | undefined) {
    const next = { ...draft() };
    const defaults = COMMANDS[command].keys;
    // The default again isn't an override.
    if (keys === undefined || (typeof keys === "string" && defaults.length === 1 && sameChord(keys, defaults[0]))) delete next[command];
    else next[command] = keys;
    setDraft(next);
    input.value = text(next);
    setError("");
  }
  /** The other commands bound to one of `command`'s keys. */
  const clashes = (command: Command) => {
    const o = draft();
    const mine = keysFor(command, o);
    return all.filter((c) => c !== command && keysFor(c, o).some((k) => mine.some((m) => sameChord(k, m))));
  };

  onSettled(() => {
    // Before anything else sees the key (the editor's shortcuts, the dialog's Escape).
    const onKey = (e: KeyboardEvent) => {
      const command = recording();
      if (!command || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return void setRecording(null);
      const chord = chordOf(e);
      if (!chord) return;
      bind(command, chord);
      setRecording(null);
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  });

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
                    <div class={["shortcuts-row", { overridden: c in draft(), recording: recording() === c }]}>
                      <dt>
                        <span>
                          {COMMANDS[c].label}
                          <Show when={c in draft()}>
                            <span class="shortcut-custom">custom</span>
                          </Show>
                        </span>
                        <code>{c}</code>
                        <Show when={clashes(c).length}>
                          <span class="shortcut-clash">
                            <i class="i-lucide-triangle-alert" aria-hidden="true" /> Also{" "}
                            {clashes(c)
                              .map((o) => COMMANDS[o].label.toLowerCase())
                              .join(", ")}
                          </span>
                        </Show>
                      </dt>
                      <dd>
                        <Show
                          when={recording() === c}
                          fallback={
                            <>
                              <For each={keysFor(c, draft())} fallback={<span class="unbound">none</span>}>
                                {(chord) => (
                                  <span class="chord">
                                    <For each={chordKeys(chord)}>{(k) => <kbd>{k}</kbd>}</For>
                                  </span>
                                )}
                              </For>
                              <Show when={c in draft()}>
                                <button type="button" class="shortcut-action" title="Back to the default" aria-label={`Reset ${COMMANDS[c].label}`} onClick={() => bind(c, undefined)}>
                                  <i class="i-lucide-rotate-ccw" aria-hidden="true" />
                                </button>
                              </Show>
                              <button type="button" class="shortcut-action" title="Record new keys" aria-label={`Change the keys for ${COMMANDS[c].label}`} onClick={() => setRecording(c)}>
                                <i class="i-lucide-pencil" aria-hidden="true" />
                              </button>
                            </>
                          }
                        >
                          <span class="shortcut-recording" role="status">
                            Press keys… <span class="unbound">Esc cancels</span>
                          </span>
                          <button
                            type="button"
                            class="shortcut-action text"
                            onClick={() => {
                              bind(c, null);
                              setRecording(null);
                            }}
                          >
                            Remove
                          </button>
                        </Show>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
      <p class="shortcuts-note">Some keys (like ⌘W or Ctrl+T) belong to the browser and never reach the page.</p>
      {/* Open from the start when there are overrides to see. */}
      <details class="shortcuts-custom" open={initial.trim() !== "{}"}>
        <summary>Edit as JSON</summary>
        <label class="dialog-label" for={id}>
          Command names to a chord, a list of chords, or <code>null</code> to unbind, e.g.{" "}
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
          onInput={() => {
            setError("");
            // Valid JSON shows in the list as it's typed.
            try {
              const value: unknown = JSON.parse(input.value.trim() || "{}");
              if (!checkOverrides(value)) setDraft(value as Overrides);
            } catch {}
          }}
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
