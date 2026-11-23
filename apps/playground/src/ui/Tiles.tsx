import { For, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TilingCommand } from "../keymap";
import { pref } from "../prefs";
import { dwindle, insert, isTreeOf, layout, leaves, move, neighbor, remove, resize, setRatio, swap, toEdge, toggleSplit, type Dir, type Rect, type Tree } from "../tiling";

/**
 * The tiling layout (a prototype; `?layout=tiling` or the command palette turns it on): the panels as tiles of a
 * binary split tree (../tiling.ts), after Hyprland's dwindle layout. A panel can go anywhere: moved with the keyboard
 * or dragged onto another panel's side, swapped, maximized, floated over the rest, hidden.
 *
 * The panels are siblings in a fixed order, each placed by a rectangle worked out from the tree. Rearranging the
 * layout only changes those rectangles, so no panel is ever moved in the DOM or mounted again: the preview's frames
 * don't reload and the terminal keeps its screen.
 */

export const TILES = ["files", "editor", "preview", "console"] as const;
export type Tile = (typeof TILES)[number];

/** The ids the classic layout's panels have, which style.css and the scripts know them by. */
const IDS: Record<Tile, string> = { files: "tree-panel", editor: "editor-panel", preview: "preview-panel", console: "console-wrap" };
const LABELS: Record<Tile, string> = { files: "Files", editor: "Editor", preview: "Preview", console: "Console" };

/** Between two tiles, and around them all (main's own padding adds to the sides and the bottom). */
const GAP = 8;
const INSET = 4;
/** The least a dragged border leaves a tile. */
const MIN = 90;

/** What's kept: the tree of the tiled panels, the hidden ones (which keep their place in it), and the floating ones' boxes as shares of the room. */
type Saved = { tree: Tree | null; hidden: Tile[]; floating: Partial<Record<Tile, Rect>> };

const START: Saved = {
  tree: { axis: "row", ratio: 0.16, a: "files", b: { axis: "row", ratio: 0.5, a: "editor", b: { axis: "col", ratio: 0.5, a: "preview", b: "console" } } },
  hidden: [],
  floating: {},
};

const MODE_KEY = "layout.mode";

/** Whether this page uses the tiling layout: `?layout=tiling|classic` picks (and is kept), else the last pick. */
export function tilingMode(): boolean {
  try {
    const asked = new URLSearchParams(location.search).get("layout");
    if (asked === "tiling" || asked === "classic") localStorage.setItem(MODE_KEY, asked);
    return localStorage.getItem(MODE_KEY) === "tiling";
  } catch {
    return false;
  }
}

/** Switches layouts. With a reload: the panels would have to be mounted again, and a terminal doesn't survive that. */
export function setTilingMode(on: boolean) {
  localStorage.setItem(MODE_KEY, on ? "tiling" : "classic");
  const url = new URL(location.href);
  url.searchParams.delete("layout");
  location.replace(url);
}

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

const DIRS: Partial<Record<TilingCommand, Dir>> = { focusLeft: "left", focusDown: "down", focusUp: "up", focusRight: "right", moveLeft: "left", moveDown: "down", moveUp: "up", moveRight: "right" };

export type Tiling = ReturnType<typeof createTiling>;

/** The layout's state and its commands. Create it in the component that renders `<Tiles>`. */
export function createTiling() {
  const [stored, store] = pref<Saved>("layout.tiles", START, {
    deserialize(data) {
      const s = JSON.parse(data) as Saved;
      const floating = Object.keys(s.floating ?? {}).filter((t): t is Tile => (TILES as readonly string[]).includes(t));
      const tiled = TILES.filter((t) => !floating.includes(t));
      if (!isTreeOf(s.tree, tiled) || !Array.isArray(s.hidden)) throw new Error("layout.tiles: not a layout of the panels");
      return { tree: s.tree, hidden: s.hidden.filter((t) => TILES.includes(t)), floating: Object.fromEntries(floating.map((t) => [t, s.floating[t]])) };
    },
  });
  // Read once, like the classic layout's sizes: each tab keeps its own layout while open.
  const saved = cell<Saved>(untrack(stored));
  /** What a project's `panels` asks for, over the reader's own choice and not saved. */
  const forced = cell<Partial<Record<Tile, boolean>> | null>(null);
  const focus = cell<Tile>("editor");
  const max = cell<Tile | null>(null);
  const room = cell({ w: 0, h: 0 });
  /** On for the moment after a command, so the tiles glide to their places; off while dragging or resizing the window. */
  const [animating, setAnimating] = createSignal(false);
  let settle: ReturnType<typeof setTimeout> | undefined;
  const animate = () => {
    setAnimating(true);
    clearTimeout(settle);
    settle = setTimeout(() => setAnimating(false), 260);
  };

  const commit = (next: Saved) => {
    saved.set(next);
    store(next);
  };
  const hiddenOf = (s: Saved, f: Partial<Record<Tile, boolean>> | null) => new Set(TILES.filter((t) => (f?.[t] !== undefined ? !f[t] : s.hidden.includes(t))));
  const boxOf = (r: { w: number; h: number }): Rect => ({ x: INSET, y: INSET, w: Math.max(0, r.w - 2 * INSET), h: Math.max(0, r.h - 2 * INSET) });
  const view = createMemo(() => layout(saved.get().tree, boxOf(room.get()), GAP, hiddenOf(saved.get(), forced.get())));
  /** The same, from the latest values (in an event handler, where a memo may lag). */
  const viewNow = () => layout(saved.now().tree, boxOf(room.now()), GAP, hiddenOf(saved.now(), forced.now()));
  const hiddenNow = () => hiddenOf(saved.now(), forced.now());
  const shownNow = () => TILES.filter((t) => !hiddenNow().has(t));

  const shown = (tile: Tile) => !hiddenOf(saved.get(), forced.get()).has(tile);
  /** The tile's box in the room, in pixels. */
  const rectOf = (tile: Tile): Rect | undefined => {
    const box = boxOf(room.get());
    if (max.get() === tile) return box;
    const f = saved.get().floating[tile];
    if (f) return { x: box.x + f.x * box.w, y: box.y + f.y * box.h, w: f.w * box.w, h: f.h * box.h };
    return view().rects.get(tile);
  };

  const setFocus = (tile: Tile) => {
    if (focus.now() !== tile) focus.set(tile);
    if (max.now() !== null && max.now() !== tile) max.set(null);
  };
  /** Where focus goes when its tile goes away. */
  const refocus = () => {
    if (hiddenNow().has(focus.now())) focus.set(shownNow().find((t) => !saved.now().floating[t]) ?? shownNow()[0] ?? "editor");
    if (max.now() !== null && hiddenNow().has(max.now()!)) max.set(null);
  };

  const setShown = (tile: Tile, on: boolean) => {
    const s = saved.now();
    const f = forced.now();
    if (f && tile in f) forced.set({ ...f, [tile]: undefined });
    commit({ ...s, hidden: on ? s.hidden.filter((t) => t !== tile) : [...s.hidden.filter((t) => t !== tile), tile] });
    if (on) setFocus(tile);
    refocus();
    animate();
  };

  /** Floats a tiled panel over the rest, or puts a floating one back beside the tile that had focus last. */
  let lastTiled: Tile = "editor";
  /** The tile each floating one was beside, to go back next to. */
  const beside: Partial<Record<Tile, Tile>> = {};
  const toggleFloat = (tile: Tile) => {
    const s = saved.now();
    if (s.floating[tile]) {
      const { [tile]: _, ...floating } = s.floating;
      const visible = leaves(s.tree).filter((t) => !hiddenNow().has(t as Tile));
      const target = [beside[tile], lastTiled].find((t) => t && visible.includes(t)) ?? visible[0] ?? leaves(s.tree)[0];
      commit({ ...s, floating, tree: target === undefined ? tile : dwindle(s.tree, tile, target, viewNow().rects.get(target)) });
    } else {
      const rects = viewNow().rects;
      beside[tile] = (["left", "up", "right", "down"] as const).map((d) => neighbor(rects, tile, d)).find((t) => t) as Tile | undefined;
      commit({ ...s, tree: remove(s.tree, tile), floating: { ...s.floating, [tile]: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 } } });
    }
    if (max.now() === tile) max.set(null);
    animate();
  };

  /** Runs one of the layout's commands on the focused tile; false if it has nothing to act on. */
  const run = (command: TilingCommand): boolean => {
    const s = saved.now();
    const tile = focus.now();
    if (command === "tileReset") {
      forced.set(null);
      max.set(null);
      commit(START);
      animate();
      return true;
    }
    if (hiddenNow().has(tile)) {
      refocus();
      return shownNow().length > 0 && command.startsWith("focus");
    }
    const floating = s.floating[tile];
    const dir = DIRS[command];
    if (dir && command.startsWith("focus")) {
      const rects = new Map(viewNow().rects);
      // A floating tile looks for neighbors from where it floats; the others only see tiled ones.
      const box = boxOf(room.now());
      if (floating) rects.set(tile, { x: box.x + floating.x * box.w, y: box.y + floating.y * box.h, w: floating.w * box.w, h: floating.h * box.h });
      const next = (neighbor(rects, tile, dir) ?? (floating ? [...viewNow().rects.keys()][0] : undefined)) as Tile | undefined;
      if (next) focusTile(next);
      return true;
    }
    if (dir) {
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
      return true;
    }
    switch (command) {
      case "tileSplit":
        if (floating || s.tree === null) return true;
        commit({ ...s, tree: toggleSplit(s.tree, tile) });
        break;
      case "tileMaximize":
        max.set(max.now() === tile ? null : tile);
        break;
      case "tileFloat":
        toggleFloat(tile);
        break;
      case "tileClose":
        setShown(tile, false);
        break;
      case "tileGrow":
      case "tileShrink": {
        const by = command === "tileGrow" ? 0.05 : -0.05;
        if (floating) {
          const w = Math.min(1, Math.max(0.2, floating.w + by));
          const h = Math.min(1, Math.max(0.2, floating.h + by));
          commit({ ...s, floating: { ...s.floating, [tile]: { x: Math.max(0, Math.min(floating.x, 1 - w)), y: Math.max(0, Math.min(floating.y, 1 - h)), w, h } } });
        } else if (s.tree !== null) commit({ ...s, tree: resize(s.tree, tile, by, hiddenNow()) });
        break;
      }
    }
    animate();
    return true;
  };

  /** Set by `<Tiles>`: puts the keyboard's focus in the tile. */
  let focusElement: (tile: Tile) => void = () => {};
  const focusTile = (tile: Tile) => {
    setFocus(tile);
    focusElement(tile);
  };

  return {
    saved,
    room,
    max,
    view,
    viewNow,
    boxOf,
    rectOf,
    commit,
    animate,
    animating,
    hiddenNow,
    /** The tile the commands act on. */
    focus: focus.get,
    setFocus(tile: Tile) {
      setFocus(tile);
      if (!saved.now().floating[tile]) lastTiled = tile;
    },
    focusTile,
    onFocusElement(fn: (tile: Tile) => void) {
      focusElement = fn;
    },
    /** Whether the panel shows (tracked). */
    shown,
    /** Shows or hides a panel, as the reader's choice: kept, and over what a project asked for. */
    toggle: (tile: Tile) => setShown(tile, hiddenNow().has(tile)),
    /** A project's `panels` (null: none): shown or hidden as it asks while it is open, without changing what's kept. */
    override(want: Partial<Record<Tile, boolean>> | null) {
      forced.set(want);
      refocus();
    },
    /** Shows a panel a project hid, for as long as the project's choice stands. */
    reveal(tile: Tile) {
      if (!hiddenNow().has(tile)) return;
      if (forced.now()?.[tile] === false) forced.set({ ...forced.now(), [tile]: true });
      else setShown(tile, true);
      animate();
    },
    run,
  };
}

/** Where a dragged tile would land: on a side of another tile, in its place (`swap`), or along an edge of the room. */
type Drop = { target: Tile | null; zone: Dir | "swap"; rect: Rect };

/** The tiles, each around its panel (`panes`, built once), with the borders to drag between them. */
export function Tiles(props: { tiling: Tiling; panes: Record<Tile, () => JSX.Element> }) {
  const tl = untrack(() => props.tiling);
  const panes = untrack(() => props.panes);
  let root!: HTMLDivElement;
  const [dragging, setDragging] = createSignal<Tile | "border" | null>(null);
  const [drop, setDrop] = createSignal<Drop | null>(null);
  const [activeHandle, setActiveHandle] = createSignal<string | null>(null);
  // By path: a string stays the same row of <For> while its handle's rectangle changes under the pointer.
  const handlePaths = createMemo(() => (tl.max.get() === null ? tl.view().handles.map((h) => h.path) : []));
  const handle = (path: string) => tl.view().handles.find((h) => h.path === path);
  // Hidden tiles stay where they were, so they don't fly in from a corner when shown again.
  const last: Partial<Record<Tile, Rect>> = {};
  const styleOf = (tile: Tile) => {
    const r = tl.rectOf(tile) ?? last[tile];
    if (!r) return { left: "0px", top: "0px", width: "0px", height: "0px" };
    last[tile] = r;
    return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` };
  };
  const several = () => TILES.filter((t) => tl.shown(t)).length > 1;

  /** The pointer in the room's coordinates. */
  const point = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** Follows the pointer until it is let go (or the drag is cancelled). */
  const track = (onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent | null) => void) => {
    const move = (e: PointerEvent) => onMove(e);
    const stop = (e: Event) => {
      removeEventListener("pointermove", move);
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
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
    addEventListener("pointercancel", stop);
    addEventListener("keydown", key, true);
  };

  const dragBorder = (path: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging("border");
    setActiveHandle(path);
    track(
      (e) => {
        const h = tl.viewNow().handles.find((h) => h.path === path);
        const tree = tl.saved.now().tree;
        if (!h || tree === null) return;
        const p = point(e);
        const [at, start, size] = h.axis === "row" ? [p.x, h.box.x, h.box.w - GAP] : [p.y, h.box.y, h.box.h - GAP];
        if (size <= 2 * MIN) return;
        const px = Math.min(size - MIN, Math.max(MIN, at - start - GAP / 2));
        tl.commit({ ...tl.saved.now(), tree: setRatio(tree, path, px / size) });
      },
      () => {
        setDragging(null);
        setActiveHandle(null);
      },
    );
  };
  const nudgeBorder = (path: string, e: KeyboardEvent) => {
    const h = handle(path);
    const tree = tl.saved.now().tree;
    if (!h || tree === null) return;
    const by = h.axis === "row" ? (e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0) : e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!by) return;
    e.preventDefault();
    const size = (h.axis === "row" ? h.box.w : h.box.h) - GAP;
    const px = (h.axis === "row" ? h.rect.x - h.box.x : h.rect.y - h.box.y) + by * 16;
    tl.commit({ ...tl.saved.now(), tree: setRatio(tree, path, px / size) });
  };

  /** Where the tile would land with the pointer at `p`. */
  const dropAt = (tile: Tile, p: { x: number; y: number }): Drop | null => {
    const box = tl.boxOf(tl.room.now());
    const rects = tl.viewNow().rects;
    if (rects.size > 1 || !rects.has(tile)) {
      const edge = 18;
      const side: Dir | undefined = p.x < box.x + edge ? "left" : p.x > box.x + box.w - edge ? "right" : p.y < box.y + edge ? "up" : p.y > box.y + box.h - edge ? "down" : undefined;
      if (side) return { target: null, zone: side, rect: half(box, side, 0.3) };
    }
    for (const [name, r] of rects) {
      if (name === tile || p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
      const [fx, fy] = [(p.x - r.x) / r.w, (p.y - r.y) / r.h];
      if (Math.abs(fx - 0.5) < 0.2 && Math.abs(fy - 0.5) < 0.2) return { target: name as Tile, zone: "swap", rect: r };
      const sides: [number, Dir][] = [
        [fx, "left"],
        [1 - fx, "right"],
        [fy, "up"],
        [1 - fy, "down"],
      ];
      const zone = sides.sort((a, b) => a[0] - b[0])[0][1];
      return { target: name as Tile, zone, rect: half(r, zone, 0.5) };
    }
    return null;
  };
  const land = (tile: Tile, d: Drop) => {
    const s = tl.saved.now();
    if (d.zone !== "swap" && d.target === null) return tl.commit({ ...s, tree: toEdge(s.tree, tile, d.zone) });
    if (d.target === null || s.tree === null) return;
    if (d.zone === "swap") return tl.commit({ ...s, tree: swap(s.tree, tile, d.target) });
    tl.commit({ ...s, tree: insert(remove(s.tree, tile), tile, d.target, d.zone === "left" || d.zone === "right" ? "row" : "col", d.zone === "left" || d.zone === "up") });
  };

  /** Drags a tile: a tiled one onto another's side or middle, or an edge of the room; a floating one to where it's let go. */
  const dragTile = (tile: Tile, e: PointerEvent) => {
    if (e.button !== 0 || tl.max.now() === tile) return;
    e.preventDefault();
    tl.setFocus(tile);
    const from = point(e);
    const floating = tl.saved.now().floating[tile];
    let moved = false;
    track(
      (e) => {
        const p = point(e);
        if (!moved && Math.hypot(p.x - from.x, p.y - from.y) < 4) return;
        moved = true;
        setDragging(tile);
        if (floating) {
          const box = tl.boxOf(tl.room.now());
          const x = Math.min(1 - floating.w, Math.max(0, floating.x + (p.x - from.x) / box.w));
          const y = Math.min(1 - floating.h, Math.max(0, floating.y + (p.y - from.y) / box.h));
          tl.commit({ ...tl.saved.now(), floating: { ...tl.saved.now().floating, [tile]: { ...floating, x, y } } });
        } else setDrop(dropAt(tile, p));
      },
      (e) => {
        const d = drop();
        setDragging(null);
        setDrop(null);
        if (!e || !d || floating) return;
        land(tile, d);
        tl.animate();
      },
    );
  };
  /** A floating tile's bottom right corner: drags its size. */
  const dragCorner = (tile: Tile, e: PointerEvent) => {
    const floating = tl.saved.now().floating[tile];
    if (e.button !== 0 || !floating) return;
    e.preventDefault();
    e.stopPropagation();
    const from = point(e);
    setDragging("border");
    track(
      (e) => {
        const p = point(e);
        const box = tl.boxOf(tl.room.now());
        const w = Math.min(1 - floating.x, Math.max(0.15, floating.w + (p.x - from.x) / box.w));
        const h = Math.min(1 - floating.y, Math.max(0.15, floating.h + (p.y - from.y) / box.h));
        tl.commit({ ...tl.saved.now(), floating: { ...tl.saved.now().floating, [tile]: { ...floating, w, h } } });
      },
      () => setDragging(null),
    );
  };

  const tileOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest<HTMLElement>(".tile")?.dataset.tile as Tile | undefined) : undefined);

  onSettled(() => {
    const observer = new ResizeObserver(() => tl.room.set({ w: root.clientWidth, h: root.clientHeight }));
    observer.observe(root);
    tl.room.set({ w: root.clientWidth, h: root.clientHeight });
    // On the way down: the tile takes the focus whatever in it was pressed, and Alt+drag moves it from anywhere on it.
    const onDown = (e: PointerEvent) => {
      const tile = tileOf(e.target);
      if (!tile) return;
      tl.setFocus(tile);
      if (e.altKey && e.button === 0) {
        e.stopPropagation();
        dragTile(tile, e);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const tile = tileOf(e.target);
      if (tile) tl.setFocus(tile);
    };
    // A click into a frame (the preview) only shows here as the window losing focus to it.
    const onBlur = () =>
      setTimeout(() => {
        const tile = tileOf(document.activeElement);
        if (tile && document.activeElement instanceof HTMLIFrameElement) tl.setFocus(tile);
      });
    root.addEventListener("pointerdown", onDown, { capture: true });
    root.addEventListener("focusin", onFocusIn);
    addEventListener("blur", onBlur);
    tl.onFocusElement((tile) => {
      const el = root.querySelector<HTMLElement>(`.tile[data-tile="${tile}"]`);
      if (!el || el.contains(document.activeElement)) return;
      // The panel's own place to type (the editor, the terminal, the tree's search), else the tile.
      const inner = el.querySelector<HTMLElement>('[contenteditable="true"], textarea:not([disabled]), input:not([type="hidden"]):not([disabled])');
      (inner?.checkVisibility() ? inner : el).focus({ preventScroll: true });
    });
    return () => {
      observer.disconnect();
      root.removeEventListener("pointerdown", onDown, { capture: true });
      root.removeEventListener("focusin", onFocusIn);
      removeEventListener("blur", onBlur);
      tl.onFocusElement(() => {});
    };
  });

  return (
    <div class="tiles" ref={root} data-animating={tl.animating() ? "" : undefined} data-dragging={dragging() ? "" : undefined}>
      <For each={TILES}>
        {(tile) => (
          <div
            id={IDS[tile]}
            class="tile"
            role="group"
            aria-label={LABELS[tile]}
            tabindex="-1"
            data-tile={tile}
            data-hidden={tl.shown(tile) ? undefined : ""}
            data-focused={tl.focus() === tile && several() ? "" : undefined}
            data-floating={tl.saved.get().floating[tile] ? "" : undefined}
            data-max={tl.max.get() === tile ? "" : undefined}
            data-dragged={dragging() === tile ? "" : undefined}
            style={styleOf(tile)}
          >
            {untrack(panes[tile])}
            <div class="tile-grip" title={`Drag to move ${LABELS[tile]} (or Alt+drag anywhere on it)`} onPointerDown={(e) => dragTile(tile, e)} />
            <div class="tile-corner" onPointerDown={(e) => dragCorner(tile, e)} />
          </div>
        )}
      </For>
      <For each={handlePaths()}>
        {(path) => (
          <div
            class="tile-handle"
            role="separator"
            tabindex="0"
            aria-label="Resize panels"
            aria-orientation={handle(path)?.axis === "row" ? "vertical" : "horizontal"}
            data-axis={handle(path)?.axis}
            data-active={activeHandle() === path ? "" : undefined}
            style={rectStyle(handle(path)?.rect)}
            onPointerDown={(e) => dragBorder(path, e)}
            onKeyDown={(e) => nudgeBorder(path, e)}
            onDblClick={() => {
              const tree = tl.saved.now().tree;
              if (tree === null) return;
              tl.commit({ ...tl.saved.now(), tree: setRatio(tree, path, 0.5) });
              tl.animate();
            }}
          />
        )}
      </For>
      <div class="tile-drop" hidden={!drop()} style={rectStyle(drop()?.rect)} />
    </div>
  );
}

const rectStyle = (r: Rect | undefined) => (r ? { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } : {});

/** The `share` of `r` on that side. */
function half(r: Rect, side: Dir, share: number): Rect {
  if (side === "left") return { ...r, w: r.w * share };
  if (side === "right") return { ...r, x: r.x + r.w * (1 - share), w: r.w * share };
  if (side === "up") return { ...r, h: r.h * share };
  return { ...r, y: r.y + r.h * (1 - share), h: r.h * share };
}
