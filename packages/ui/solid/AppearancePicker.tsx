import { For, createSignal, onSettled, type ParentProps } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import { FAMILIES, FamilyListbox } from "./FamilyListbox";
import { topLayerOf } from "./layer";
import { Swatch } from "./Swatch";
import { Tip } from "./Tip";
import "../css/segmented.css";
import "../css/appearance.css";

export type Mode = "system" | "light" | "dark";

const MODES: [Mode, string, string][] = [
  ["system", "i-lucide-monitor", "System"],
  ["light", "i-lucide-sun", "Light"],
  ["dark", "i-lucide-moon", "Dark"],
];

export type AppearanceProps = ParentProps<{
  mode: Mode;
  /** The family on screen, by its light theme: the kept one, or the one being previewed. */
  family: string;
  setMode: (mode: Mode) => void;
  /** Show a family without keeping it (pointer or keyboard focus on it in the list). */
  preview: (family: string) => void;
  /** Keep a family. */
  pick: (family: string) => void;
  /** The trigger's id. */
  id?: string;
}>;

/**
 * Appearance: a swatch button opening the system/light/dark toggle over the theme families, then `children` (more
 * sections). A family under the pointer or keyboard focus previews at once; clicking one keeps it, and closing the
 * popover or moving the pointer off the list without one puts the kept family back. Where the mode and family live is
 * the caller's (the props).
 */
export function AppearancePicker(props: AppearanceProps) {
  const current = () => FAMILIES.find((f) => f.light === props.family) ?? FAMILIES[0]!;
  // The family a preview falls back to: the one shown when the popover opened, or the last one clicked.
  // Set whenever the popover opens; nothing reads it before then.
  const [kept, setKept] = createSignal("");
  const restore = () => props.family !== kept() && props.preview(kept());
  const [open, setOpen] = createSignal(false);
  // Into the top layer the picker sits in, if any (layer.ts).
  let root: HTMLSpanElement | undefined;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setKept(current().light);
    else restore();
  };
  // Closing with Escape puts focus back on the trigger (it would fall to <body>).
  let trigger: HTMLElement | undefined;
  const dismiss = () => {
    onOpenChange(false);
    trigger?.focus();
  };

  // A click in an iframe (the playground's preview) never reaches this document, so Kobalte doesn't see it as a click
  // outside; it moves focus into the frame, which blurs this window. Close then, leaving focus where the click put it.
  onSettled(() => {
    const onBlur = () => open() && document.activeElement instanceof HTMLIFrameElement && onOpenChange(false);
    addEventListener("blur", onBlur);
    return () => removeEventListener("blur", onBlur);
  });

  return (
    <span ref={root} class="appearance-root">
      <Popover placement="bottom-end" gutter={6} open={open()} onOpenChange={onOpenChange}>
        <Tip
          as={Popover.Trigger}
          ref={(el: HTMLElement) => (trigger = el)}
          id={props.id}
          class="select-trigger appearance-trigger"
          placement="bottom-end"
          tip={`Appearance: ${current().name}, ${props.mode}`}
          aria-label="Appearance"
        >
          <Swatch light={current().light} />
          <i class={MODES.find(([m]) => m === props.mode)?.[1]} aria-hidden="true" />
          <span class="chevron">
            <i class="i-lucide-chevron-down" aria-hidden="true" />
          </span>
        </Tip>
        <Popover.Portal mount={topLayerOf(root)}>
          {/* Escape closes it from anywhere inside. Kobalte's own dismiss went to another layer (the trigger's tooltip,
              which also marks the event handled), and the listbox keeps Escape to itself (so: onEscape below). */}
          <Popover.Content class="appearance" onKeyDown={(e: KeyboardEvent) => e.key === "Escape" && dismiss()}>
            {/* One mode is always on: clicking the pressed one again (onChange(null)) changes nothing. */}
            <ToggleGroup class="segmented" aria-label="Color scheme" value={props.mode} onChange={(mode) => mode && props.setMode(mode as Mode)}>
              <For each={MODES}>
                {([mode, icon, label]) => (
                  <ToggleGroup.Item value={mode} title={`${label} color scheme`}>
                    <i class={icon} aria-hidden="true" />
                    {label}
                  </ToggleGroup.Item>
                )}
              </For>
            </ToggleGroup>
            <FamilyListbox
              value={kept()}
              onPick={(light) => {
                setKept(light);
                props.pick(light); // previewed already, unless picked from the keyboard without moving focus
              }}
              onFocusFamily={(light) => props.preview(light)}
              onPointerLeave={restore}
              onEscape={dismiss}
            />
            {props.children}
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </span>
  );
}
