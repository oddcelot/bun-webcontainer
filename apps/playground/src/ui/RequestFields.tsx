import { For, Show } from "solid-js";
import { Tip } from "@runbun/ui/solid/Tip";
import type { Field } from "../request";

// The request bar's parts that Settings' preset requests use too (Preview.tsx, Settings.tsx). Their styles are
// style.css's `#req-panel` block, which also applies under `.request-presets`.

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** An HTTP method as a tinted badge in its own color (style.css); DELETE reads DEL, in full for screen readers. */
export function MethodBadge(props: { method: string }) {
  return (
    <span class="method-badge" data-method={props.method}>
      <Show when={props.method === "DELETE"} fallback={props.method}>
        <span aria-hidden="true">DEL</span>
        <span class="sr-only">DELETE</span>
      </Show>
    </span>
  );
}

/**
 * Name and value rows (the query's parameters, headers, a form's fields), with one empty row after them to add one:
 * typing in it makes it a row (`onChange` with the index one past the last) and another empty one appears under it.
 * Rows go by index, so the field being typed in stays put. With `toggles`, each row has a checkbox to turn it off
 * (the empty row's is dimmed, so the column reads as one);
 * with `files`, a button that makes its value a path to a project file (offered from the `files` datalist, read when
 * its value is focused: `onFiles`). `derived` is a read-only row first, one Auth writes; clicking it opens Auth.
 */
export function Fields(props: {
  label: string;
  rows: readonly Field[];
  toggles?: boolean;
  names?: string;
  files?: boolean;
  onFiles?: () => void;
  /** Whether a file row's path is a project file: one that isn't is marked. */
  fileExists?: (path: string) => boolean;
  derived?: { name: string; value: string; open: () => void };
  hidden: boolean;
  onChange: (i: number, change: Partial<Field>) => void;
  onRemove: (i: number) => void;
}) {
  const all = () => [...props.rows, { name: "", value: "", on: true } as Field];
  return (
    <div class="fields" role="group" aria-label={props.label} hidden={props.hidden}>
      <Show when={props.derived}>
        {(d) => (
          <button type="button" class="field derived" title="Set in Auth. Click to edit" onClick={() => d().open()}>
            <i class="i-lucide-lock" aria-hidden="true" />
            <span class="name">{d().name}</span>
            <span class="value">{d().value}</span>
            <span class="from">
              Edit in Auth <i class="i-lucide-arrow-right" aria-hidden="true" />
            </span>
          </button>
        )}
      </Show>
      <For each={all()} keyed={false}>
        {(row, i) => (
          <div class="field" data-new={i === props.rows.length ? "" : undefined}>
            <Show when={props.toggles}>
              <input
                type="checkbox"
                checked={row().on !== false && i < props.rows.length}
                disabled={i === props.rows.length}
                aria-label={`Send ${row().name || `row ${i + 1}`}`}
                onChange={(e) => props.onChange(i, { on: e.currentTarget.checked })}
              />
            </Show>
            <input
              class="name"
              spellcheck={false}
              autocomplete="off"
              placeholder={i === props.rows.length ? "Add name" : "Name"}
              list={props.names}
              aria-label={`${props.label}: name ${i + 1}`}
              value={row().name}
              onInput={(e) => props.onChange(i, { name: e.currentTarget.value })}
            />
            <input
              class="value"
              spellcheck={false}
              autocomplete="off"
              placeholder={row().file ? "Path of a project file" : "Value"}
              list={row().file ? "project-files" : undefined}
              data-file={row().file ? "" : undefined}
              aria-invalid={row().file && row().value.trim() && props.fileExists && !props.fileExists(row().value) ? "true" : undefined}
              title={row().file && row().value.trim() && props.fileExists && !props.fileExists(row().value) ? "No such file in the project" : undefined}
              aria-label={`${props.label}: ${row().file ? "file" : "value"} ${i + 1}`}
              value={row().value}
              onFocus={() => row().file && props.onFiles?.()}
              onInput={(e) => props.onChange(i, { value: e.currentTarget.value })}
            />
            <Show when={props.files}>
              <Tip
                type="button"
                class="kind"
                tip={row().file ? "Send text instead" : "Send a project file"}
                aria-label={`${row().file ? "Text" : "File"} for ${row().name || `row ${i + 1}`}`}
                aria-pressed={row().file ? "true" : "false"}
                onClick={() => {
                  props.onChange(i, { file: !row().file });
                  if (!row().file) props.onFiles?.();
                }}
              >
                <i class="i-lucide-paperclip" aria-hidden="true" />
              </Tip>
            </Show>
            <Tip
              type="button"
              class="remove"
              tip="Remove"
              aria-label={`Remove ${row().name || `row ${i + 1}`}`}
              hidden={i === props.rows.length}
              onClick={() => props.onRemove(i)}
            >
              <i class="i-lucide-x" aria-hidden="true" />
            </Tip>
          </div>
        )}
      </For>
    </div>
  );
}

