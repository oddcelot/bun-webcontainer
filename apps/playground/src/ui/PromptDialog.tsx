import { Show, createUniqueId } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Dialog } from "@kobalte/core/dialog";

/**
 * A modal that asks for one line of text (the accessible stand-in for `prompt()`): a labelled input, preselected,
 * Enter submits, Esc cancels. The caller owns `open`; `onSubmit` gets the trimmed text (never empty), and the dialog
 * closes itself. Closing hands focus to `returnFocus` (there's no Dialog.Trigger to return it to).
 */
export function PromptDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: JSX.Element;
  label: string;
  initial: string;
  submit: string;
  onSubmit: (value: string) => void;
  returnFocus?: () => HTMLElement | undefined | null;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Dialog.Content
            class="dialog"
            onOpenAutoFocus={(e) => {
              // Past the close button's default: straight into the field, text selected for replacing.
              e.preventDefault();
              const input = (e.currentTarget as HTMLElement | null)?.querySelector("input");
              input?.focus();
              input?.select();
            }}
            onCloseAutoFocus={(e) => {
              const el = props.returnFocus?.();
              if (el) {
                e.preventDefault();
                el.focus();
              }
            }}
          >
            <PromptForm {...props} />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

// Inside Dialog.Content so each opening starts from `initial` (the content unmounts on close).
function PromptForm(props: Parameters<typeof PromptDialog>[0]) {
  const id = createUniqueId();
  let input!: HTMLInputElement;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        props.onOpenChange(false);
        props.onSubmit(value);
      }}
    >
      <Dialog.Title class="dialog-title">{props.title}</Dialog.Title>
      <Show when={props.description}>
        <Dialog.Description class="dialog-description">{props.description}</Dialog.Description>
      </Show>
      <label class="dialog-label" for={id}>
        {props.label}
      </label>
      <input ref={input} id={id} class="input" value={props.initial} spellcheck={false} autocomplete="off" />
      <div class="dialog-actions">
        <Dialog.CloseButton class="button" type="button">
          Cancel
        </Dialog.CloseButton>
        <button class="button primary" type="submit">
          {props.submit}
        </button>
      </div>
    </form>
  );
}
