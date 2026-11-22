import { For, Show, createSignal, createUniqueId, onSettled, untrack } from "solid-js";
import { Dialog, DialogActions, DialogClose, DialogTitle, DialogTrigger, useDialogContext } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Input } from "@runbun/ui/solid/Input";
import { COMMANDS, checkOverrides, chordKeys, chordOf, currentOverrides, keysFor, scopeOf, sameChord, setOverrides, setRecordingKeys, type Command, type Overrides } from "../keymap";
import { Key, Keys, Tip } from "@runbun/ui/solid/Tip";

// Open from the header's button or the command palette.
const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
/** Opens the shortcuts dialog (the command palette's Keyboard shortcuts). */
export const openShortcuts = () => setShortcutsOpen(true);

/**
 * The keyboard shortcuts in effect, each one re-recordable (or reset), and the JSON that changes them: command names
 * to a chord, a list of chords, or null to unbind. Kept in this browser, for every project. Its button is in the header.
 */
export function Shortcuts(props: { id?: string }) {
  return (
    <Dialog
      open={shortcutsOpen()}
      onOpenChange={setShortcutsOpen}
      class="shortcuts"
      trigger={
        <Tip as={DialogTrigger} id={props.id} tip="Keyboard shortcuts" aria-label="Keyboard shortcuts">
          <i class="i-lucide-keyboard" aria-hidden="true" />
        </Tip>
      }
    >
      <ShortcutsForm />
    </Dialog>
  );
}

/** The commands by what they act on, in the dialog's order. */
const GROUPS: { title: string; commands: Command[] }[] = [
  { title: "Go", commands: ["quickOpen", "commandPalette"] },
  { title: "Run", commands: ["run", "stop"] },
  { title: "Files", commands: ["save", "format", "closeTab"] },
  { title: "Code", commands: ["goToDefinition", "showHover", "suggest", "signatureHelp"] },
  { title: "Layout", commands: ["toggleExplorer", "toggleGit", "toggleConsole", "togglePreview", "exitFullscreen"] },
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
  const [recording, setRecordingSignal] = createSignal<Command | null>(null);
  // The keymap knows too, so the shortcuts handled on the way down leave the keys to the dialog.
  const setRecording = (c: Command | null) => {
    setRecordingKeys(c !== null);
    setRecordingSignal(c);
  };
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
  /**
   * The other commands bound to one of `command`'s keys, in the same scope: a scoped command's keys go first where it
   * works, so it doesn't clash with a global one (keymap.ts scopeOf).
   */
  const clashes = (command: Command) => {
    const o = draft();
    const mine = keysFor(command, o);
    return all.filter((c) => c !== command && scopeOf(c) === scopeOf(command) && keysFor(c, o).some((k) => mine.some((m) => sameChord(k, m))));
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
      <DialogTitle>Keyboard shortcuts</DialogTitle>
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
                            <i class="i-lucide-triangle-alert" aria-hidden="true" /> Same keys as{" "}
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
                                    <For each={chordKeys(chord)}>{(k) => <Key name={k} />}</For>
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
                            Press keys… <span class="unbound"><kbd>Esc</kbd> cancels</span>
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
      <p class="shortcuts-note">
        The browser keeps some keys, like <Keys keys={[["⌘", "W"]]} /> and <Keys keys={[["Ctrl", "T"]]} />.
      </p>
      {/* Open from the start when there are overrides to see. */}
      <details class="shortcuts-custom" open={initial.trim() !== "{}"}>
        <summary>Edit as JSON</summary>
        <label class="dialog-label" for={id}>
          Map command names to a chord, a list of chords, or <code>null</code> to unbind. <code>Mod</code> is Cmd on macOS,
          Ctrl elsewhere.
        </label>
        <Input
          multiline
          ref={input}
          id={id}
          class="shortcuts-json"
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
      <DialogActions>
        <DialogClose>Cancel</DialogClose>
        <Button primary type="submit">
          Save
        </Button>
      </DialogActions>
    </form>
  );
}
