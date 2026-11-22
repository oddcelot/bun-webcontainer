import { For, Show, createSignal, untrack } from "solid-js";
import { Combobox } from "@kobalte/core/combobox";
import { Tip } from "./Tip";
import "../css/select.css";
import "../css/path-list.css";

/**
 * A list of paths, each with a remove button, and a last row that adds one: a combobox (Kobalte's) offering
 * `suggestions` as you type, picked with a click or Enter; Enter or the + button adds what's typed when it's none of
 * them (a folder, a file not made yet). A path already listed isn't added twice.
 */
export function PathList(props: { label: string; value: string[]; suggestions: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = createSignal("");
  // Bumped after each add: the combobox mounts afresh, empty, with the list's new suggestions (Kobalte reads its
  // options once; see Select.tsx).
  const [round, setRound] = createSignal(0);
  let input: HTMLInputElement | undefined;
  /** Set when Enter picked a suggestion, so the same Enter doesn't also add the typed text. */
  let picked = false;
  const add = (raw: string) => {
    const path = raw.trim().replace(/^\.?\//, "");
    if (!path) return;
    setDraft("");
    if (!props.value.includes(path)) props.onChange([...props.value, path]);
    setRound((n) => n + 1);
    // The new combobox's input, focused again for the next one.
    queueMicrotask(() => requestAnimationFrame(() => input?.focus()));
  };
  return (
    <ul class="path-list" aria-label={props.label}>
      <For each={props.value}>
        {(path) => (
          <li>
            <span class="path" title={path}>
              {path}
            </span>
            <Tip type="button" class="remove" tip={`Remove ${path}`} aria-label={`Remove ${path}`} onClick={() => props.onChange(props.value.filter((p) => p !== path))}>
              <i class="i-lucide-x" aria-hidden="true" />
            </Tip>
          </li>
        )}
      </For>
      <li class="add">
        {/* Keyed on the list too: a removed path is offered again. */}
        <Show when={`${round()}\n${props.value.join("\n")}`} keyed>
          {(_) => (
            <Combobox<string>
              class="combobox"
              // Read once per mount, as Kobalte does.
              options={untrack(() => props.suggestions.filter((s) => !props.value.includes(s)))}
              onChange={(v) => {
                if (!v) return;
                picked = true;
                add(v);
              }}
              onInputChange={setDraft}
              defaultFilter="contains"
              triggerMode="input"
              placeholder={props.placeholder ?? "Add a path"}
              gutter={4}
              sameWidth
              itemComponent={(p) => (
                <Combobox.Item item={p.item} class="select-option">
                  <Combobox.ItemLabel class="name">{p.item.rawValue}</Combobox.ItemLabel>
                </Combobox.Item>
              )}
            >
              <Combobox.Control class="control" aria-label={`Add to ${props.label}`}>
                {/* Kobalte 2 alpha types the input's props as the DOM interface's (no `class`): passed as a plain object. */}
                <Combobox.Input
                  {...({
                    ref: (el: HTMLInputElement) => (input = el),
                    class: "input",
                    spellcheck: false,
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key !== "Enter") return;
                      // Kobalte picks a highlighted suggestion on this Enter (onChange); without one, the text is added.
                      picked = false;
                      const text = draft();
                      queueMicrotask(() => !picked && add(text));
                    },
                  } as object)}
                />
              </Combobox.Control>
              <Combobox.Portal>
                <Combobox.Content class="select-menu path-menu">
                  <Combobox.Listbox class="select-list" />
                </Combobox.Content>
              </Combobox.Portal>
            </Combobox>
          )}
        </Show>
        <Tip type="button" class="add-button" tip={draft().trim() ? `Add ${draft().trim()}` : "Type a path to add"} aria-label={`Add to ${props.label}`} disabled={!draft().trim()} onClick={() => add(draft())}>
          <i class="i-lucide-plus" aria-hidden="true" />
        </Tip>
      </li>
    </ul>
  );
}
