import type { JSX } from "@solidjs/web";
import { Dialog as Kobalte, useDialogContext } from "@kobalte/core/dialog";
import "../css/button.css";
import "../css/dialog.css";

export { useDialogContext };
/** The button that opens the dialog; for a tooltip, pass it as `<Tip as={DialogTrigger}>`. */
export const DialogTrigger = Kobalte.Trigger;

export type DialogProps = {
  /** Controlled when given (with `onOpenChange`); otherwise the dialog opens and closes itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Rendered inside the root, beside the content: a `DialogTrigger`, or a `Tip` using it. */
  trigger?: JSX.Element;
  /** Added to the content's "dialog" class (what the dialog's own stylesheet rules hang on). */
  class?: string;
  /** Focus on opening; `preventDefault()` it to move focus yourself (the default is the first focusable element). */
  onOpenAutoFocus?: (event: Event) => void;
  /** Focus on closing; `preventDefault()` it to return focus somewhere other than the trigger. */
  onCloseAutoFocus?: (event: Event) => void;
  children?: JSX.Element;
};

/**
 * A modal shell: the overlay, the centering positioner and the dialog box, portalled to the body. Its children render
 * inside the content, which unmounts on close, so state in them starts afresh on each opening.
 */
export function Dialog(props: DialogProps) {
  return (
    <Kobalte open={props.open} onOpenChange={props.onOpenChange}>
      {props.trigger}
      <Kobalte.Portal>
        <Kobalte.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Kobalte.Content
            class={props.class ? `dialog ${props.class}` : "dialog"}
            onOpenAutoFocus={props.onOpenAutoFocus}
            onCloseAutoFocus={props.onCloseAutoFocus}
          >
            {props.children}
          </Kobalte.Content>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  );
}

/** The dialog's accessible name. */
export function DialogTitle(props: { children?: JSX.Element }) {
  return <Kobalte.Title class="dialog-title">{props.children}</Kobalte.Title>;
}

/** Its accessible description, under the title. */
export function DialogDescription(props: { children?: JSX.Element }) {
  return <Kobalte.Description class="dialog-description">{props.children}</Kobalte.Description>;
}

/** The row of buttons at the foot, right-aligned. */
export function DialogActions(props: { children?: JSX.Element }) {
  return <div class="dialog-actions">{props.children}</div>;
}

/** A button that closes the dialog, in the library Button's look. */
export function DialogClose(props: { class?: string; children?: JSX.Element }) {
  return (
    <Kobalte.CloseButton class={props.class ? `button ${props.class}` : "button"} type="button">
      {props.children}
    </Kobalte.CloseButton>
  );
}
