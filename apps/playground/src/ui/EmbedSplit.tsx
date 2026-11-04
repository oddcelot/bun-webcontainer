import { For, createEffect, createMemo, createSignal, onSettled } from "solid-js";

/** What a reader can resize: the tree's width, the editor's share beside the side column (or over it, stacked), the preview's over the console, the console's height under the editor. */
export type Size = "tree" | "side" | "rows" | "console" | "stack";
type Sizes = Partial<Record<Size, number>>;
/** A border to drag between pane `a` and pane `b` (left of it, or over it), by element id. */
export type Split = { size: Size; a: string; b: string; label: string };

const ACROSS: Record<Size, boolean> = { tree: true, side: true, rows: false, console: false, stack: false };
const MIN_TREE = 110;
const MIN_WIDE = 120;
const MIN_TALL = 60;
const STEP = 16;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
// fr factors summing to 100: under 1 they'd leave part of the space empty.
const ratio = (r: number) => `minmax(0, ${r * 100}fr) minmax(0, ${(1 - r) * 100}fr)`;

/** Sizes as embed.css's custom properties; an unset one falls back to the default there. */
function toVars(s: Sizes) {
  return {
    "--tree-w": s.tree === undefined ? undefined : `${s.tree}px`,
    "--side-cols": s.side === undefined ? undefined : ratio(s.side),
    "--rows": s.rows === undefined ? undefined : ratio(s.rows),
    "--console-h": s.console === undefined ? undefined : `${s.console}px`,
    "--stack-rows": s.stack === undefined ? undefined : ratio(s.stack),
  };
}

/** The sizes the reader dragged, kept for the tab in sessionStorage under `key` (theme.ts: nothing in localStorage). */
export function createSizes(key: string) {
  let current: Sizes = {};
  try {
    current = JSON.parse(sessionStorage.getItem(key) ?? "{}");
  } catch {}
  const [vars, setVars] = createSignal(toVars(current));
  const set = (next: Sizes) => {
    current = next;
    setVars(toVars(next));
  };
  return {
    vars,
    set: (size: Size, value: number) => set({ ...current, [size]: value }),
    reset: (size: Size) => set({ ...current, [size]: undefined }),
    save() {
      try {
        sessionStorage.setItem(key, JSON.stringify(current));
      } catch {}
    },
  };
}

/** Where a split's handle goes (over the gap between its panes, a little wider) and the panes' sizes along it. */
function measure(split: Split) {
  const main = document.getElementById("embed-main")?.getBoundingClientRect();
  const a = document.getElementById(split.a)?.getBoundingClientRect();
  const b = document.getElementById(split.b)?.getBoundingClientRect();
  if (!main || !a || !b || !a.width || !b.width || !a.height || !b.height) return;
  if (ACROSS[split.size]) {
    const top = Math.min(a.top, b.top);
    return { left: a.right - main.left - 2, top: top - main.top, width: b.left - a.right + 4, height: Math.max(a.bottom, b.bottom) - top, a: a.width, b: b.width, main: main.width };
  }
  const left = Math.min(a.left, b.left);
  return { left: left - main.left, top: a.bottom - main.top - 2, width: Math.max(a.right, b.right) - left, height: b.top - a.bottom + 4, a: a.height, b: b.height, main: main.height };
}

/**
 * Handles on the borders between the embed's panes (embed.css lays them out on a grid): dragging one, or arrow keys
 * on it, sets the grid's custom properties; a double click goes back to the default. Rendered in #embed-main and
 * placed over the gaps from the panes' boxes.
 */
export function Splits(props: { splits: Split[]; sizes: ReturnType<typeof createSizes> }) {
  const [tick, setTick] = createSignal(0);
  const observer = new ResizeObserver(() => setTick((t) => t + 1));
  // Panes mount when first shown, so watch whichever are there each time the splits change.
  createEffect(
    () => props.splits,
    () => {
      const main = document.getElementById("embed-main");
      if (!main) return;
      observer.disconnect();
      observer.observe(main);
      for (const pane of main.querySelectorAll(":scope > .pane")) observer.observe(pane);
    },
  );
  onSettled(() => () => observer.disconnect());
  return <For each={props.splits}>{(split) => <Handle split={split} sizes={props.sizes} tick={tick} />}</For>;
}

function Handle(props: { split: Split; sizes: ReturnType<typeof createSizes>; tick: () => number }) {
  const { size, label } = props.split;
  const across = ACROSS[size];
  const box = createMemo(() => (props.tick(), measure(props.split)));
  const [dragging, setDragging] = createSignal(false);

  /** Moves the border by `d` pixels from where the panes were (`m`), within the panes' minimums. */
  function move(m: NonNullable<ReturnType<typeof measure>>, d: number) {
    const total = m.a + m.b;
    const min = across ? MIN_WIDE : MIN_TALL;
    if (size === "tree") return props.sizes.set(size, Math.round(clamp(m.a + d, MIN_TREE, m.main / 2)));
    const a = clamp(m.a + d, min, total - min);
    props.sizes.set(size, size === "console" ? Math.round(total - a) : a / total);
  }

  let start: { at: number; m: NonNullable<ReturnType<typeof measure>> } | undefined;
  const onPointerDown = (e: PointerEvent) => {
    const m = measure(props.split);
    if (e.button !== 0 || !m) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start = { at: across ? e.clientX : e.clientY, m };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (start) move(start.m, (across ? e.clientX : e.clientY) - start.at);
  };
  const onPointerUp = () => {
    if (!start) return;
    start = undefined;
    setDragging(false);
    props.sizes.save();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const d = { [across ? "ArrowLeft" : "ArrowUp"]: -STEP, [across ? "ArrowRight" : "ArrowDown"]: STEP, Home: -Infinity, End: Infinity }[e.key];
    const m = measure(props.split);
    if (d === undefined || !m) return;
    e.preventDefault();
    move(m, d);
    props.sizes.save();
  };

  return (
    <div
      class="resize-handle"
      role="separator"
      tabindex="0"
      aria-label={label}
      aria-orientation={across ? "vertical" : "horizontal"}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={box() ? Math.round((100 * box()!.a) / (box()!.a + box()!.b)) : undefined}
      data-orientation={across ? "horizontal" : "vertical"}
      data-size={size}
      data-active={dragging() ? "" : undefined}
      data-dragging={dragging() ? "" : undefined}
      hidden={!box()}
      style={box() ? { left: `${box()!.left}px`, top: `${box()!.top}px`, width: `${box()!.width}px`, height: `${box()!.height}px` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDblClick={() => {
        props.sizes.reset(size);
        props.sizes.save();
      }}
    />
  );
}
