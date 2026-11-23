import { Show, untrack } from "solid-js";
import { Combobox } from "@kobalte/core/combobox";
import "../css/select.css";
import "../css/path-list.css";
import "../css/path-input.css";

/**
 * One path, typed or picked: a text field with a chevron that opens `suggestions`, narrowed as you type (PathList's
 * combobox, for a single value). A click or Enter on a suggestion takes it; Enter or leaving the field takes what's
 * typed, a suggestion or not (a file not made yet). Empty is a value too: `onChange("")`.
 */
export function PathInput(props: { id?: string; label: string; value: string; suggestions: string[]; onChange: (value: string) => void; placeholder?: string }) {
  /** What the reader typed since the field was last committed (null: nothing), apart from Kobalte's own resets of the text. */
  let typed: string | null = null;
  const commit = (raw: string) => {
    const path = raw.trim().replace(/^\.?\//, "");
    typed = null;
    if (path !== props.value) props.onChange(path);
  };
  return (
    // Mounted afresh per value: Kobalte reads its options and its value once (see Select.tsx).
    <Show when={`value:${props.value}`} keyed>
      {(_) => (
        <Combobox<string>
          class="path-input"
          options={untrack(() => props.suggestions)}
          // The field's text is the value (set below), a suggestion or not: nothing is selected, and leaving keeps the text.
          noResetInputOnBlur
          onChange={(v) => v && commit(v)}
          defaultFilter="contains"
          triggerMode="input"
          placeholder={props.placeholder}
          gutter={4}
          sameWidth
          itemComponent={(p) => (
            <Combobox.Item item={p.item} class="select-option">
              <Combobox.ItemLabel class="name">{p.item.rawValue}</Combobox.ItemLabel>
            </Combobox.Item>
          )}
        >
          <Combobox.Control class="control" aria-label={props.label}>
            {/* Kobalte 2 alpha types the input's props as the DOM interface's (no `class`): passed as a plain object. */}
            <Combobox.Input
              {...({
                // Listeners of its own for typing and leaving, beside Kobalte's.
                ref: (el: HTMLInputElement) => {
                  // After Kobalte has set its own (empty) text and id. The id for a label's `for`: as a prop, Kobalte
                  // reads it untracked, which Solid warns about.
                  queueMicrotask(() => {
                    el.value = untrack(() => props.value);
                    const id = untrack(() => props.id);
                    if (id) el.id = id;
                  });
                  el.addEventListener("input", () => (typed = el.value));
                  el.addEventListener("blur", () => typed !== null && commit(typed));
                },
                class: "input",
                spellcheck: false,
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key !== "Enter" || typed === null) return;
                  // Kobalte picks a highlighted suggestion on this Enter (onChange, which clears `typed`); else the text is taken.
                  const text = typed;
                  queueMicrotask(() => typed !== null && commit(text));
                },
              } as object)}
            />
            <Combobox.Trigger class="trigger" aria-label={`Show the suggestions for ${props.label}`}>
              <Combobox.Icon class="chevron">
                <i class="i-lucide-chevron-down" aria-hidden="true" />
              </Combobox.Icon>
            </Combobox.Trigger>
          </Combobox.Control>
          <Combobox.Portal>
            <Combobox.Content class="select-menu path-menu">
              <Combobox.Listbox class="select-list" />
            </Combobox.Content>
          </Combobox.Portal>
        </Combobox>
      )}
    </Show>
  );
}
