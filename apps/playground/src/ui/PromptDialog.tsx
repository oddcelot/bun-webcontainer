import { Show, createSignal, createUniqueId } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Input } from "@runbun/ui/solid/Input";

/**
 * A modal that asks for one line of text (the accessible stand-in for `prompt()`): a labelled input, preselected,
 * Enter submits, Esc cancels. The caller owns `open`; `onSubmit` gets the trimmed text (never empty), and the dialog
 * closes itself. Closing hands focus to `returnFocus` (there's no Dialog.Trigger to return it to). `children` go under
 * the field (more choices); `check` refuses a value with a message shown there, keeping the dialog open.
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
  check?: (value: string) => string | undefined;
  returnFocus?: () => HTMLElement | undefined | null;
  children?: JSX.Element;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
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
    </Dialog>
  );
}

// Inside Dialog.Content so each opening starts from `initial` (the content unmounts on close).
function PromptForm(props: Parameters<typeof PromptDialog>[0]) {
  const id = createUniqueId();
  const [problem, setProblem] = createSignal<string | undefined>();
  let input!: HTMLInputElement;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        const refused = props.check?.(value);
        setProblem(refused);
        if (refused) return input.focus();
        props.onOpenChange(false);
        props.onSubmit(value);
      }}
    >
      <DialogTitle>{props.title}</DialogTitle>
      <Show when={props.description}>
        <DialogDescription>{props.description}</DialogDescription>
      </Show>
      <label class="dialog-label" for={id}>
        {props.label}
      </label>
      <Input ref={input} id={id} value={props.initial} spellcheck={false} autocomplete="off" aria-invalid={problem() ? "true" : undefined} aria-describedby={problem() ? `${id}-problem` : undefined} onInput={() => setProblem()} />
      <Show when={problem()}>
        <p class="dialog-error" id={`${id}-problem`} role="alert">
          {problem()}
        </p>
      </Show>
      {props.children}
      <DialogActions>
        <DialogClose>Cancel</DialogClose>
        <Button primary type="submit">
          {props.submit}
        </Button>
      </DialogActions>
    </form>
  );
}
