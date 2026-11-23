import { For, createContext, createMemo, createSignal, omit, onSettled, untrack, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { dwindle, insert, isTreeOf, layout as place, leaves, move, neighbor, remove, resize, setRatio, swap, toEdge, toggleSplit, type Dir, type Rect, type Tree } from "./tilingTree";
import "../css/tiling.css";

/**
 * A tiling layout, after Hyprland's dwindle: panels as tiles of a binary split tree (tilingTree.ts), which can be
 * moved by direction or by dragging, swapped, turned, resized, maximized, floated over the rest and hidden.
 *
 * In parts, like a Kobalte component, with the state the caller's (`createTiling`):
 *
 *   const tiling = createTiling({ tiles: ["files", "editor"], defaultLayout, onLayoutChange: save });
 *   <Tiling tiling={tiling}>
 *     <Tiling.Tile tileId="files" aria-label="Files">
 *       <Files />
 *       <Tiling.Grip />
 *       <Tiling.Corner />
 *     </Tiling.Tile>
 *     <Tiling.Tile tileId="editor" aria-label="Editor">…</Tiling.Tile>
 *     <Tiling.Handles aria-label="Resize panels" />
 *     <Tiling.DropIndicator />
 *   </Tiling>
 *
 * The tiles are siblings in the order written, each placed by a rectangle worked out from the tree. Rearranging only
 * changes those rectangles: no tile is moved in the DOM or mounted again, so a frame in one doesn't reload and a
 * terminal keeps its screen. For the same reason a hidden tile stays mounted (`data-hidden`).
 *
 * Each part carries data attributes to style by: the root `data-tiling-root`, `data-animating` (for the moment after
 * a command, to transition the rectangles) and `data-dragging`; a tile `data-tiling-tile`, `data-tile` (its id),
 * `data-focused`, `data-hidden`, `data-floating`, `data-maximized` and `data-dragging`; a handle `data-tiling-handle`,
 * `data-orientation` (`horizontal` between tiles side by side) and `data-active`; a crossing of handles
 * `data-tiling-crossing` and `data-active`; the indicator `data-tiling-drop`.
 */

export type { Dir, Rect, Tree } from "./tilingTree";

/** What there is to keep: the tree of the tiled tiles, the hidden ones (which keep their place in it), and the floating ones' boxes as shares of the room. */
export type TilingLayout<T extends string = string> = { tree: Tree | null; hidden: T[]; floating: Partial<Record<T, Rect>> };

/** Whether `value` (parsed from storage, say) is a layout of exactly `tiles`. */
export function isTilingLayout<T extends string>(value: unknown, tiles: readonly T[]): value is TilingLayout<T> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<TilingLayout<T>>;
  if (!Array.isArray(v.hidden) || !v.hidden.every((t) => tiles.includes(t))) return false;
  if (typeof v.floating !== "object" || v.floating === null) return false;
  const floating = Object.keys(v.floating);
  const box = (r: unknown) => typeof r === "object" && r !== null && (["x", "y", "w", "h"] as const).every((k) => typeof (r as Rect)[k] === "number");
  if (!floating.every((t) => (tiles as readonly string[]).includes(t) && box(v.floating![t as T]))) return false;
  return isTreeOf(v.tree, tiles.filter((t) => !floating.includes(t)));
}

export type TilingOptions<T extends string> = {
  /** Every tile's id; each has a `Tiling.Tile`. */
  tiles: readonly T[];
  /** The layout to start with, and the one `reset` brings back. */
  defaultLayout: TilingLayout<T>;
  /** The layout to start with instead, if there is one (a stored one). Read once. */
  initialLayout?: TilingLayout<T>;
  /** The tile that has focus to start with (the first). */
  initialFocus?: T;
  /** Called with each layout the reader makes (not with what `override` shows or hides), to keep it. */
  onLayoutChange?: (layout: TilingLayout<T>) => void;
  /** Pixels between two tiles (8). */
  gap?: number;
  /** Pixels around them all (0). */
  inset?: number;
  /** The least a dragged border leaves a tile, in pixels (90). */
  minSize?: number;
};

/** A signal with its latest value readable at once: several steps of one event each build on the one before. */
function cell<T>(initial: T) {
  const [get, set] = createSignal<T>(initial as Exclude<T, Function>);
  let now = initial;
  return {
    get,
    now: () => now,
    set(value: T) {
      now = value;
      set(() => value);
    },
  };
}

/** Where a dragged tile would land: on a side of another tile, in its place (`swap`), or along an edge of the room. */
type Drop<T> = { target: T | null; zone: Dir | "swap"; rect: Rect };

export type TilingState<T extends string = string> = ReturnType<typeof createTiling<T>>;

/** A tiling layout's state and commands, for a `<Tiling>` to draw. Create it in a component (or a root). */
export function createTiling<T extends string>(options: TilingOptions<T>) {
  const { tiles } = options;
  const gap = options.gap ?? 8;
  const inset = options.inset ?? 0;
  const minSize = options.minSize ?? 90;
  const saved = cell<TilingLayout<T>>(options.initialLayout ?? options.defaultLayout);
  /** Tiles shown or hidden over the reader's own choice, and not kept. */
  const forced = cell<Partial<Record<T, boolean>> | null>(null);
  const focus = cell<T>(options.initialFocus ?? tiles[0]);
  const max = cell<T | null>(null);
  const room = cell({ w: 0, h: 0 });
  const [animating, setAnimating] = createSignal(false);
  let settle: ReturnType<typeof setTimeout> | undefined;
  /** Lets the tiles glide to their places for a moment; not while dragging or as the room resizes. */
  const animate = () => {
    setAnimating(true);
    clearTimeout(settle);
    settle = setTimeout(() => setAnimating(false), 260);
  };

  const commit = (next: TilingLayout<T>) => {
    saved.set(next);
    options.onLayoutChange?.(next);
  };
  const hiddenOf = (s: TilingLayout<T>, f: Partial<Record<T, boolean>> | null) => new Set<string>(tiles.filter((t) => (f?.[t] !== undefined ? !f[t] : s.hidden.includes(t))));
  const boxOf = (r: { w: number; h: number }): Rect => ({ x: inset, y: inset, w: Math.max(0, r.w - 2 * inset), h: Math.max(0, r.h - 2 * inset) });
  const view = createMemo(() => place(saved.get().tree, boxOf(room.get()), gap, hiddenOf(saved.get(), forced.get())));
  // The same from the latest values: in an event handler a memo may lag a write made just before.
  const hiddenNow = () => hiddenOf(saved.now(), forced.now());
  const viewNow = () => place(saved.now().tree, boxOf(room.now()), gap, hiddenNow());
  const shownNow = () => tiles.filter((t) => !hiddenNow().has(t));
  const floatRect = (f: Rect, box: Rect): Rect => ({ x: box.x + f.x * box.w, y: box.y + f.y * box.h, w: f.w * box.w, h: f.h * box.h });

  /** The tile's box in the room, in pixels (tracked); undefined while it is hidden. */
  const rectOf = (tile: T): Rect | undefined => {
    const box = boxOf(room.get());
    if (max.get() === tile) return box;
    const f = saved.get().floating[tile];
    return f ? floatRect(f, box) : view().rects.get(tile);
  };

  /** The tiled tile that had focus last, and the tile each floating one was beside: where a floating one goes back to. */
  let lastTiled: T | undefined;
  const beside: Partial<Record<T, T>> = {};
  const setFocus = (tile: T) => {
    if (focus.now() !== tile) focus.set(tile);
    if (!saved.now().floating[tile]) lastTiled = tile;
    if (max.now() !== null && max.now() !== tile) max.set(null);
  };
  /** Set by `<Tiling>`: puts the keyboard's focus in the tile's element. */
  let focusElement: (tile: T) => void = () => {};
  const focusTile = (tile: T) => {
    setFocus(tile);
    focusElement(tile);
  };
  /** Where focus goes when its tile goes away. */
  const refocus = () => {
    const shown = shownNow();
    if (hiddenNow().has(focus.now()) && shown.length) focus.set(shown.find((t) => !saved.now().floating[t]) ?? shown[0]);
    if (max.now() !== null && hiddenNow().has(max.now()!)) max.set(null);
  };

  const setShown = (tile: T, on: boolean) => {
    const s = saved.now();
    const f = forced.now();
    if (f && tile in f) forced.set({ ...f, [tile]: undefined });
    commit({ ...s, hidden: on ? s.hidden.filter((t) => t !== tile) : [...s.hidden.filter((t) => t !== tile), tile] });
    if (on) setFocus(tile);
    refocus();
    animate();
  };

  const toggleFloating = (tile: T = focus.now()) => {
    const s = saved.now();
    if (s.floating[tile]) {
      const { [tile]: _, ...rest } = s.floating;
      const visible = leaves(s.tree).filter((t) => !hiddenNow().has(t));
      const target = [beside[tile], lastTiled].find((t) => t && visible.includes(t)) ?? visible[0] ?? leaves(s.tree)[0];
      commit({ ...s, floating: rest as TilingLayout<T>["floating"], tree: target === undefined ? tile : dwindle(s.tree, tile, target, viewNow().rects.get(target)) });
    } else {
      const rects = viewNow().rects;
      beside[tile] = (["left", "up", "right", "down"] as const).map((d) => neighbor(rects, tile, d)).find((t) => t) as T | undefined;
      commit({ ...s, tree: remove(s.tree, tile), floating: { ...s.floating, [tile]: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 } } });
    }
    if (max.now() === tile) max.set(null);
    animate();
  };

  /** The focused tile if it shows; otherwise focus moves to one that does, and the command is dropped. */
  const subject = (): T | undefined => {
    const tile = focus.now();
    if (!hiddenNow().has(tile)) return tile;
    refocus();
    return undefined;
  };

  const dropAt = (tile: T, p: { x: number; y: number }): Drop<T> | null => {
    const box = boxOf(room.now());
    const rects = viewNow().rects;
    if (rects.size > 1 || !rects.has(tile)) {
      const edge = 18;
      const side: Dir | undefined = p.x < box.x + edge ? "left" : p.x > box.x + box.w - edge ? "right" : p.y < box.y + edge ? "up" : p.y > box.y + box.h - edge ? "down" : undefined;
      if (side) return { target: null, zone: side, rect: part(box, side, 0.3) };
    }
    for (const [name, r] of rects) {
      if (name === tile || p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
      const [fx, fy] = [(p.x - r.x) / r.w, (p.y - r.y) / r.h];
      if (Math.abs(fx - 0.5) < 0.2 && Math.abs(fy - 0.5) < 0.2) return { target: name as T, zone: "swap", rect: r };
      const sides: [number, Dir][] = [
        [fx, "left"],
        [1 - fx, "right"],
        [fy, "up"],
        [1 - fy, "down"],
      ];
      const zone = sides.sort((a, b) => a[0] - b[0])[0][1];
      return { target: name as T, zone, rect: part(r, zone, 0.5) };
    }
    return null;
  };
  const land = (tile: T, d: Drop<T>) => {
    const s = saved.now();
    if (d.zone !== "swap" && d.target === null) commit({ ...s, tree: toEdge(s.tree, tile, d.zone) });
    else if (d.target === null || s.tree === null) return;
    else if (d.zone === "swap") commit({ ...s, tree: swap(s.tree, tile, d.target) });
    else commit({ ...s, tree: insert(remove(s.tree, tile), tile, d.target, d.zone === "left" || d.zone === "right" ? "row" : "col", d.zone === "left" || d.zone === "up") });
    animate();
  };

  return {
    tiles,
    /** The layout now (tracked). */
    layout: saved.get,
    /** Replaces the layout, as the reader's. */
    setLayout(next: TilingLayout<T>) {
      commit(next);
      refocus();
      animate();
    },
    /** The tile the commands act on (tracked). */
    focused: focus.get,
    /** Focuses a tile: the commands act on it, and the keyboard's focus goes into it. */
    focus: focusTile,
    /** The maximized tile, if any (tracked). */
    maximized: max.get,
    /** Whether the tile shows (tracked). */
    shown: (tile: T) => !hiddenOf(saved.get(), forced.get()).has(tile),
    /** Shows or hides a tile, as the reader's choice: kept, and over an `override`. A hidden tile keeps its place. */
    setShown,
    toggle: (tile: T) => setShown(tile, hiddenNow().has(tile)),
    /** Shows or hides tiles for now (null: no more), without changing the reader's layout: a document's own wishes. */
    override(want: Partial<Record<T, boolean>> | null) {
      forced.set(want);
      refocus();
    },
    /** Shows a tile: one an `override` hid for as long as that stands, else as the reader's choice. */
    reveal(tile: T) {
      if (!hiddenNow().has(tile)) return;
      if (forced.now()?.[tile] === false) forced.set({ ...forced.now()!, [tile]: true });
      else setShown(tile, true);
      animate();
    },
    /** Focuses the focused tile's neighbor on that side. */
    focusDirection(dir: Dir) {
      const tile = subject();
      if (tile === undefined) return;
      const rects = new Map(viewNow().rects);
      // A floating tile looks for neighbors from where it floats; the others only see tiled ones.
      const floating = saved.now().floating[tile];
      if (floating) rects.set(tile, floatRect(floating, boxOf(room.now())));
      const next = (neighbor(rects, tile, dir) ?? (floating ? [...viewNow().rects.keys()][0] : undefined)) as T | undefined;
      if (next) focusTile(next);
    },
    /**
     * Moves the focused tile one step that way: it trades places with a sibling there, goes beside a longer neighbor
     * or past an equal one, and with none takes the whole of that edge. A floating one is nudged.
     */
    move(dir: Dir) {
      const tile = subject();
      if (tile === undefined) return;
      const s = saved.now();
      const floating = s.floating[tile];
      if (floating) {
        const step = 0.05;
        const x = Math.min(1 - floating.w, Math.max(0, floating.x + (dir === "left" ? -step : dir === "right" ? step : 0)));
        const y = Math.min(1 - floating.h, Math.max(0, floating.y + (dir === "up" ? -step : dir === "down" ? step : 0)));
        commit({ ...s, floating: { ...s.floating, [tile]: { ...floating, x, y } } });
      } else if (s.tree !== null) {
        if (max.now() !== null) max.set(null);
        commit({ ...s, tree: move(s.tree, tile, dir, viewNow().rects) });
      }
      animate();
    },
    /** Turns the split the focused tile is in: side by side becomes one over the other. */
    toggleSplit() {
      const tile = subject();
      const s = saved.now();
      if (tile === undefined || s.floating[tile] || s.tree === null) return;
      commit({ ...s, tree: toggleSplit(s.tree, tile) });
      animate();
    },
    /** Lets a tile (the focused one) fill the room, or puts it back. */
    toggleMaximized(tile: T | undefined = subject()) {
      if (tile === undefined) return;
      max.set(max.now() === tile ? null : tile);
      animate();
    },
    /** Floats a tile (the focused one) over the rest, or tiles it again beside the one it was next to. */
    toggleFloating,
    /** Grows the focused tile by a share of its split (negative shrinks); a floating one in both directions. */
    grow(by: number) {
      const tile = subject();
      if (tile === undefined) return;
      const s = saved.now();
      const floating = s.floating[tile];
      if (floating) {
        const w = Math.min(1, Math.max(0.2, floating.w + by));
        const h = Math.min(1, Math.max(0.2, floating.h + by));
        commit({ ...s, floating: { ...s.floating, [tile]: { x: Math.max(0, Math.min(floating.x, 1 - w)), y: Math.max(0, Math.min(floating.y, 1 - h)), w, h } } });
      } else if (s.tree !== null) commit({ ...s, tree: resize(s.tree, tile, by, hiddenNow()) });
      animate();
    },
    /** Back to `defaultLayout`, with nothing overridden or maximized. */
    reset() {
      forced.set(null);
      max.set(null);
      commit(options.defaultLayout);
      refocus();
      animate();
    },
    /** For the parts below. */
    internal: { gap, minSize, saved, room, max, view, viewNow, boxOf, rectOf, commit, animate, animating, setFocus, dropAt, land, onFocusElement: (fn: (tile: T) => void) => void (focusElement = fn) },
  };
}

type Root = {
  tiling: TilingState;
  point: (e: PointerEvent) => { x: number; y: number };
  dragging: () => string | null;
  setDragging: (what: string | null) => void;
  drop: () => Drop<string> | null;
  dragTile: (tile: string, e: PointerEvent) => void;
  dragCorner: (tile: string, e: PointerEvent) => void;
};
const RootContext = createContext<Root>();
const TileContext = createContext<string>();

const BORDER = "\0border";
const rectStyle = (r: Rect | undefined) => (r ? { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } : {});

/** The `share` of `r` on that side. */
function part(r: Rect, side: Dir, share: number): Rect {
  if (side === "left") return { ...r, w: r.w * share };
  if (side === "right") return { ...r, x: r.x + r.w * (1 - share), w: r.w * share };
  if (side === "up") return { ...r, h: r.h * share };
  return { ...r, y: r.y + r.h * (1 - share), h: r.h * share };
}

/** Follows the pointer until it is let go, or Escape cancels (`onEnd(null)`). */
function track(onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent | null) => void) {
  const stop = (e: Event) => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", stop);
    removeEventListener("pointercancel", stop);
    removeEventListener("keydown", key, true);
    onEnd(e.type === "pointerup" ? (e as PointerEvent) : null);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    stop(e);
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", stop);
  addEventListener("pointercancel", stop);
  addEventListener("keydown", key, true);
}

type DivProps = JSX.HTMLAttributes<HTMLDivElement>;

/** The room the tiles share. A press anywhere in a tile focuses it, and Alt+drag moves it from anywhere on it. */
function TilingRoot<T extends string>(props: DivProps & { tiling: TilingState<T> }) {
  const tiling = untrack(() => props.tiling) as unknown as TilingState;
  const t = tiling.internal;
  const rest = omit(props, "tiling", "class", "children");
  let root!: HTMLDivElement;
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [drop, setDrop] = createSignal<Drop<string> | null>(null);
  const point = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** A tiled tile onto another's side or middle, or an edge of the room; a floating one to where it's let go. */
  const dragTile = (tile: string, e: PointerEvent) => {
    if (e.button !== 0 || t.max.now() === tile) return;
    e.preventDefault();
    t.setFocus(tile);
    const from = point(e);
    const floating = t.saved.now().floating[tile];
    let moved = false;
    track(
      (e) => {
        const p = point(e);
        if (!moved && Math.hypot(p.x - from.x, p.y - from.y) < 4) return;
        moved = true;
        setDragging(tile);
        if (floating) {
          const box = t.boxOf(t.room.now());
          const x = Math.min(1 - floating.w, Math.max(0, floating.x + (p.x - from.x) / box.w));
          const y = Math.min(1 - floating.h, Math.max(0, floating.y + (p.y - from.y) / box.h));
          t.commit({ ...t.saved.now(), floating: { ...t.saved.now().floating, [tile]: { ...floating, x, y } } });
        } else setDrop(t.dropAt(tile, p));
      },
      (e) => {
        const d = drop();
        setDragging(null);
        setDrop(null);
        if (e && d && !floating) t.land(tile, d);
      },
    );
  };
  const dragCorner = (tile: string, e: PointerEvent) => {
    const floating = t.saved.now().floating[tile];
    if (e.button !== 0 || !floating) return;
    e.preventDefault();
    e.stopPropagation();
    const from = point(e);
    setDragging(BORDER);
    track(
      (e) => {
        const p = point(e);
        const box = t.boxOf(t.room.now());
        const w = Math.min(1 - floating.x, Math.max(0.15, floating.w + (p.x - from.x) / box.w));
        const h = Math.min(1 - floating.y, Math.max(0.15, floating.h + (p.y - from.y) / box.h));
        t.commit({ ...t.saved.now(), floating: { ...t.saved.now().floating, [tile]: { ...floating, w, h } } });
      },
      () => setDragging(null),
    );
  };

  const tileOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-tiling-tile]")?.dataset.tile : undefined);
  onSettled(() => {
    const measure = () => t.room.set({ w: root.clientWidth, h: root.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    // On the way down, before the tile's content sees it.
    const onDown = (e: PointerEvent) => {
      const tile = tileOf(e.target);
      if (!tile) return;
      t.setFocus(tile);
      if (e.altKey && e.button === 0) {
        e.stopPropagation();
        dragTile(tile, e);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const tile = tileOf(e.target);
      if (tile) t.setFocus(tile);
    };
    // A click into a frame only shows here as the window losing focus to it.
    const onBlur = () =>
      setTimeout(() => {
        const tile = tileOf(document.activeElement);
        if (tile && document.activeElement instanceof HTMLIFrameElement) t.setFocus(tile);
      });
    root.addEventListener("pointerdown", onDown, { capture: true });
    root.addEventListener("focusin", onFocusIn);
    addEventListener("blur", onBlur);
    t.onFocusElement((tile) => {
      const el = [...root.querySelectorAll<HTMLElement>(":scope > [data-tiling-tile]")].find((el) => el.dataset.tile === tile);
      if (!el || el.contains(document.activeElement)) return;
      // The tile's own place to type (an editor, a terminal, a search box), else the tile.
      const inner = el.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([disabled]), input:not([type="hidden"]):not([disabled])');
      (inner?.checkVisibility() ? inner : el).focus({ preventScroll: true });
    });
    return () => {
      observer.disconnect();
      root.removeEventListener("pointerdown", onDown, { capture: true });
      root.removeEventListener("focusin", onFocusIn);
      removeEventListener("blur", onBlur);
      t.onFocusElement(() => {});
    };
  });

  return (
    <RootContext value={{ tiling, point, dragging, setDragging, drop, dragTile, dragCorner }}>
      <div ref={root} class={["tiling", props.class]} data-tiling-root="" data-animating={t.animating() ? "" : undefined} data-dragging={dragging() !== null ? "" : undefined} {...rest}>
        {props.children}
      </div>
    </RootContext>
  );
}

/** One tile, around its content (rendered once and kept mounted). `tileId` is one of the state's `tiles`. */
function Tile(props: DivProps & { tileId: string }) {
  const root = useContext(RootContext);
  const { tiling } = root;
  const id = untrack(() => props.tileId);
  const rest = omit(props, "tileId", "class", "children");
  // A hidden tile stays where it was, so it doesn't fly in from a corner when shown again.
  let last: Rect | undefined;
  const style = () => rectStyle((last = tiling.internal.rectOf(id) ?? last) ?? { x: 0, y: 0, w: 0, h: 0 });
  const several = () => tiling.tiles.filter((t) => tiling.shown(t)).length > 1;
  return (
    <TileContext value={id}>
      <div
        class={["tiling-tile", props.class]}
        role="group"
        tabindex="-1"
        data-tiling-tile=""
        data-tile={id}
        data-hidden={tiling.shown(id) ? undefined : ""}
        data-focused={tiling.focused() === id && several() ? "" : undefined}
        data-floating={tiling.layout().floating[id] ? "" : undefined}
        data-maximized={tiling.maximized() === id ? "" : undefined}
        data-dragging={root.dragging() === id ? "" : undefined}
        style={style()}
        {...rest}
      >
        {props.children}
      </div>
    </TileContext>
  );
}

/** Inside a tile: where to take hold of it to drag it somewhere else. */
function Grip(props: DivProps) {
  const root = useContext(RootContext);
  const tile = useContext(TileContext);
  const rest = omit(props, "class");
  return <div class={["tiling-grip", props.class]} data-tiling-grip="" onPointerDown={(e) => root.dragTile(tile, e)} {...rest} />;
}

/** Inside a tile: the corner that drags its size while it floats. */
function Corner(props: DivProps) {
  const root = useContext(RootContext);
  const tile = useContext(TileContext);
  const rest = omit(props, "class");
  return <div class={["tiling-corner", props.class]} data-tiling-corner="" onPointerDown={(e) => root.dragCorner(tile, e)} {...rest} />;
}

/**
 * The borders between the tiles, one separator per split with both sides showing: dragged, moved with the arrow
 * keys when focused, and evened out by a double click. The props go on each. Where borders meet (three tiles at a
 * T, four at a cross) there is a crossing to drag them all by at once, in both directions.
 */
function Handles(props: DivProps) {
  const root = useContext(RootContext);
  const t = root.tiling.internal;
  const rest = omit(props, "class");
  const [active, setActive] = createSignal<readonly string[]>([]);
  // The borders of the crossing under the pointer, to light them up with it.
  const [hot, setHot] = createSignal<readonly string[]>([]);
  // By path: a string stays the same row of <For> while its handle's rectangle changes under the pointer.
  const paths = createMemo(() => (t.max.get() === null ? t.view().handles.map((h) => h.path) : []));
  const handle = (path: string) => t.view().handles.find((h) => h.path === path);
  const sizeOf = (h: { axis: "row" | "col"; box: Rect }) => (h.axis === "row" ? h.box.w : h.box.h) - t.gap;
  const set = (path: string, ratio: number) => {
    const tree = t.saved.now().tree;
    if (tree !== null) t.commit({ ...t.saved.now(), tree: setRatio(tree, path, ratio) });
  };
  /** Drags the borders at `paths` (one, or a crossing's) to the pointer, each along its own direction. */
  const drag = (paths: readonly string[], e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.setDragging(BORDER);
    setActive(paths);
    track(
      (e) => {
        const p = root.point(e);
        for (const path of paths) {
          // Looked up again per border: moving one changes the box of the ones inside it.
          const h = t.viewNow().handles.find((h) => h.path === path);
          if (!h) continue;
          const size = sizeOf(h);
          if (size <= 2 * t.minSize) continue;
          const at = h.axis === "row" ? p.x - h.box.x : p.y - h.box.y;
          set(path, Math.min(size - t.minSize, Math.max(t.minSize, at - t.gap / 2)) / size);
        }
      },
      () => {
        root.setDragging(null);
        setActive([]);
      },
    );
  };
  /**
   * Where a border ends on one across it, as the borders' paths joined by commas (several ending at one spot, a
   * cross, are one crossing): a string stays the same row of <For> while the crossing moves.
   */
  const crossings = createMemo(() => {
    if (t.max.get() !== null) return new Map<string, Rect>();
    const handles = t.view().handles;
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const at = new Map<string, { paths: Set<string>; rect: Rect }>();
    for (const r of handles) {
      if (r.axis !== "row") continue;
      for (const c of handles) {
        if (c.axis !== "col") continue;
        const [bar, line] = [r.rect, c.rect];
        // The line ends on the bar's side, or the bar on the line's.
        const ends = (near(line.x, bar.x + bar.w) || near(line.x + line.w, bar.x)) && line.y >= bar.y - 1 && line.y + line.h <= bar.y + bar.h + 1;
        const stands = (near(bar.y, line.y + line.h) || near(bar.y + bar.h, line.y)) && bar.x >= line.x - 1 && bar.x + bar.w <= line.x + line.w + 1;
        if (!ends && !stands) continue;
        const spot = `${Math.round(bar.x)},${Math.round(line.y)}`;
        const found = at.get(spot) ?? { paths: new Set<string>(), rect: { x: bar.x, y: line.y, w: bar.w, h: line.h } };
        found.paths.add(r.path).add(c.path);
        at.set(spot, found);
      }
    }
    // "." for the root's border, whose path is empty.
    return new Map([...at.values()].map((c) => [[...c.paths].map((p) => p || ".").sort().join(","), c.rect]));
  });
  const crossingKeys = createMemo(() => [...crossings().keys()]);
  const pathsOf = (key: string) => key.split(",").map((p) => (p === "." ? "" : p));
  const lit = (path: string) => active().includes(path) || hot().includes(path);
  const nudge = (path: string, e: KeyboardEvent) => {
    const h = handle(path);
    if (!h) return;
    const by = h.axis === "row" ? (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0) : e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!by) return;
    e.preventDefault();
    set(path, ((h.axis === "row" ? h.rect.x - h.box.x : h.rect.y - h.box.y) + by * 16) / sizeOf(h));
  };
  /** The first side's share of the split, as a separator's value. */
  const share = (path: string) => {
    const h = handle(path);
    return h ? Math.round((100 * (h.axis === "row" ? h.rect.x - h.box.x : h.rect.y - h.box.y)) / Math.max(1, sizeOf(h))) : undefined;
  };
  return (
    <>
    <For each={paths()}>
      {(path) => (
        <div
          class={["tiling-handle", props.class]}
          role="separator"
          tabindex="0"
          aria-orientation={handle(path)?.axis === "row" ? "vertical" : "horizontal"}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={share(path)}
          data-tiling-handle=""
          data-orientation={handle(path)?.axis === "row" ? "horizontal" : "vertical"}
          data-active={lit(path) ? "" : undefined}
          style={rectStyle(handle(path)?.rect)}
          onPointerDown={(e) => drag([path], e)}
          onKeyDown={(e) => nudge(path, e)}
          onDblClick={() => {
            set(path, 0.5);
            t.animate();
          }}
          {...rest}
        />
      )}
    </For>
    <For each={crossingKeys()}>
      {(key) => (
        <div
          class="tiling-crossing"
          data-tiling-crossing=""
          data-active={pathsOf(key).some((p) => active().includes(p)) && active().length > 1 ? "" : undefined}
          style={rectStyle(crossings().get(key))}
          onPointerDown={(e) => drag(pathsOf(key), e)}
          onPointerEnter={() => setHot(pathsOf(key))}
          onPointerLeave={() => setHot([])}
          onDblClick={() => {
            for (const path of pathsOf(key)) set(path, 0.5);
            t.animate();
          }}
        />
      )}
    </For>
    </>
  );
}

/** Where the tile being dragged would land; hidden otherwise. */
function DropIndicator(props: DivProps) {
  const root = useContext(RootContext);
  const rest = omit(props, "class");
  return <div class={["tiling-drop", props.class]} data-tiling-drop="" data-zone={root.drop()?.zone} hidden={!root.drop()} style={rectStyle(root.drop()?.rect)} {...rest} />;
}

export const Tiling = Object.assign(TilingRoot, { Tile, Grip, Corner, Handles, DropIndicator });
