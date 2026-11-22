import { For, Show, createSignal, createUniqueId } from "solid-js";
import { Tip } from "./Tip";
import "../css/input.css";
import "../css/path-list.css";

/**
 * A list of paths, each with a remove button, and a field under it that adds one: typing offers `suggestions` (a
 * datalist), Enter or the + button adds what's typed. A path already listed isn't added twice.
 */
export function PathList(props: { label: string; value: string[]; suggestions: string[]; onChange: (value: string[]) => void; placeholder?: string; empty?: string }) {
  const list = createUniqueId();
  const [draft, setDraft] = createSignal("");
  const add = () => {
    const path = draft().trim().replace(/^\.?\//, "");
    if (!path) return;
    setDraft("");
    if (!props.value.includes(path)) props.onChange([...props.value, path]);
  };
  return (
    <div class="path-list" role="group" aria-label={props.label}>
      <Show when={props.value.length} fallback={<p class="empty">{props.empty ?? "None"}</p>}>
        <ul>
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
        </ul>
      </Show>
      <div class="add">
        <input
          class="input"
          list={list}
          spellcheck={false}
          placeholder={props.placeholder ?? "Add a path"}
          aria-label={`Add to ${props.label}`}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <Tip type="button" class="add-button" tip="Add" aria-label={`Add to ${props.label}`} disabled={!draft().trim()} onClick={add}>
          <i class="i-lucide-plus" aria-hidden="true" />
        </Tip>
        <datalist id={list}>
          <For each={props.suggestions.filter((s) => !props.value.includes(s))}>{(s) => <option value={s} />}</For>
        </datalist>
      </div>
    </div>
  );
}
