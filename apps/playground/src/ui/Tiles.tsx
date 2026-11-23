import { For, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Tiling, createTiling, isTilingLayout, setShare, type TilingLayout, type TilingState } from "@runbun/ui/solid/Tiling";
import type { Sized } from "../projectConfig";
import type { TilingCommand } from "../keymap";
import { pref } from "../prefs";

/**
 * The playground's panels: the four as tiles of `@runbun/ui`'s Tiling, the layout kept in localStorage, and the keymap's tiling
 * commands run on it.
 */

export const TILES = ["files", "editor", "preview", "console"] as const;
export type Tile = (typeof TILES)[number];
export type Tiles = TilingState<Tile> & { sizes(next: Partial<Record<Sized, number>> | null): void };

/** The panels' ids, which style.css and the scripts know them by. */
const IDS: Record<Tile, string> = { files: "tree-panel", editor: "editor-panel", preview: "preview-panel", console: "console-wrap" };
const LABELS: Record<Tile, string> = { files: "Files", editor: "Editor", preview: "Preview", console: "Console" };

/** The arrangement at first: files, editor, preview over console. */
const START: TilingLayout<Tile> = {
  tree: { axis: "row", ratio: 0.16, a: "files", b: { axis: "row", ratio: 0.5, a: "editor", b: { axis: "col", ratio: 0.5, a: "preview", b: "console" } } },
  hidden: [],
  floating: {},
};

/**
 * In a narrow window: one over the other at full width, the file tree hidden until asked for (the status bar's
 * buttons and the keys show and hide each, as in a wide one).
 */
const STACK: TilingLayout<Tile> = {
  tree: { axis: "col", ratio: 0.3, a: "files", b: { axis: "col", ratio: 0.45, a: "editor", b: { axis: "col", ratio: 0.6, a: "preview", b: "console" } } },
  hidden: ["files"],
  floating: {},
};
/**
 * Arrangements to start from (Settings, Panels), each drawn there as a small picture of itself. Picking one makes it
 * the reader's layout, theirs to change from there.
 */
export const PRESETS: { id: string; label: string; layout: TilingLayout<Tile> }[] = [
  { id: "columns", label: "Columns", layout: START },
  {
    id: "console-below",
    label: "Console below",
    layout: { tree: { axis: "col", ratio: 0.72, a: { axis: "row", ratio: 0.16, a: "files", b: { axis: "row", ratio: 0.5, a: "editor", b: "preview" } }, b: "console" }, hidden: [], floating: {} },
  },
  {
    id: "console-under-editor",
    label: "Console under editor",
    layout: { tree: { axis: "row", ratio: 0.16, a: "files", b: { axis: "row", ratio: 0.5, a: { axis: "col", ratio: 0.7, a: "editor", b: "console" }, b: "preview" } }, hidden: [], floating: {} },
  },
  {
    id: "preview-left",
    label: "Preview left",
    layout: { tree: { axis: "row", ratio: 0.42, a: { axis: "col", ratio: 0.65, a: "preview", b: "console" }, b: { axis: "row", ratio: 0.72, a: "editor", b: "files" } }, hidden: [], floating: {} },
  },
  {
    id: "side-by-side",
    label: "Editor and preview",
    layout: { tree: { axis: "row", ratio: 0.16, a: "files", b: { axis: "row", ratio: 0.5, a: "editor", b: { axis: "col", ratio: 0.5, a: "preview", b: "console" } } }, hidden: ["files", "console"], floating: {} },
  },
  { id: "stack", label: "Stacked", layout: STACK },
];

/** A layout's arrangement without its sizes: what a preset and a layout made from it still share after a resize. */
const shape = (layout: TilingLayout<Tile>) => {
  const of = (tree: TilingLayout<Tile>["tree"]): string => (tree === null ? "" : typeof tree === "string" ? tree : `${tree.axis}(${of(tree.a)},${of(tree.b)})`);
  return `${of(layout.tree)}|${[...layout.hidden].sort()}|${Object.keys(layout.floating).sort()}`;
};
/** Whether `layout` is `preset`, resized or not. */
export const isPreset = (layout: TilingLayout<Tile>, preset: TilingLayout<Tile>) => shape(layout) === shape(preset);

/** This page's tiles, once App has made them (Settings reads and sets the layout). */
let active: Tiles | undefined;
export const activeTiles = () => active;

/** Narrower than this, the window gets a layout of its own (STACK at first): side by side, the panels would be slivers. */
const NARROW = "(width < 700px)";

/** The panels' layout, kept across reloads. Create it in the component that renders `<Tiles>`. */
export function createTiles() {
  const deserialize = (key: string) => (data: string) => {
    const layout: unknown = JSON.parse(data);
    if (!isTilingLayout(layout, TILES)) throw new Error(`${key}: not a layout of the panels`);
    return layout;
  };
  const [stored, store] = pref<TilingLayout<Tile>>("layout.tiles", START, { deserialize: deserialize("layout.tiles") });
  const [storedNarrow, storeNarrow] = pref<TilingLayout<Tile>>("layout.tiles.narrow", STACK, { deserialize: deserialize("layout.tiles.narrow") });
  // Read once: each tab keeps its own layouts while open. One for a wide window and
  // one for a narrow one, each the reader's to change and kept apart.
  const own = { wide: untrack(stored), narrow: untrack(storedNarrow) };
  const query = matchMedia(NARROW);
  let narrow = query.matches;
  let shares: Partial<Record<Sized, number>> | null = null;
  // A project's sizes name the columns of a wide window.
  const current = () => (narrow ? own.narrow : shares ? withShares(own.wide, shares) : own.wide);
  // The inset is the gap around them all, half of the one between two.
  const tiling = createTiling({
    tiles: TILES,
    defaultLayout: START,
    initialLayout: current(),
    initialFocus: "editor",
    onLayoutChange(layout) {
      if (narrow) storeNarrow((own.narrow = layout));
      else store((own.wide = layout));
    },
    gap: 8,
    inset: 4,
  });
  // For as long as the page (App creates this once).
  query.addEventListener("change", () => {
    narrow = query.matches;
    tiling.show(current());
  });
  const resetWide = tiling.reset;
  return (active = Object.assign(tiling, {
    /**
     * A project's runbun.json `sizes` (percent; null: none): the reader's layout with those shares, for as long as
     * the project is open. Not kept, unless the reader changes the layout from there.
     */
    sizes(next: Partial<Record<Sized, number>> | null) {
      if (!next && !shares) return;
      shares = next;
      if (!narrow) tiling.show(current());
    },
    /** Back to the layout this window's width starts with. */
    reset() {
      resetWide();
      if (narrow) tiling.setLayout(STACK);
    },
  }));
}

/**
 * The layout with a project's `sizes`, which name the first arrangement's columns: the file tree's and the editor's share of
 * the width they split, the preview's of the height it splits (with the console, as arranged at first).
 */
function withShares(layout: TilingLayout<Tile>, shares: Partial<Record<Sized, number>>): TilingLayout<Tile> {
  let tree = layout.tree;
  for (const tile of ["files", "editor", "preview"] as const) {
    const share = shares[tile];
    if (tree !== null && share !== undefined) tree = setShare(tree, tile, tile === "preview" ? "col" : "row", share / 100);
  }
  return { ...layout, tree };
}

/** Runs one of the keymap's tiling commands on the focused panel. */
export function runTilingCommand(tiles: TilingState<Tile>, command: TilingCommand) {
  switch (command) {
    case "focusLeft":
      return tiles.focusDirection("left");
    case "focusDown":
      return tiles.focusDirection("down");
    case "focusUp":
      return tiles.focusDirection("up");
    case "focusRight":
      return tiles.focusDirection("right");
    case "moveLeft":
      return tiles.move("left");
    case "moveDown":
      return tiles.move("down");
    case "moveUp":
      return tiles.move("up");
    case "moveRight":
      return tiles.move("right");
    case "tileSplit":
      return tiles.toggleSplit();
    case "tileMaximize":
      return tiles.toggleMaximized();
    case "tileFloat":
      return tiles.toggleFloating();
    case "tileClose":
      return tiles.setShown(tiles.focused(), false);
    case "tileGrow":
      return tiles.grow(0.05);
    case "tileShrink":
      return tiles.grow(-0.05);
    case "tileReset":
      return tiles.reset();
  }
}

/** The panels as tiles, each around its content (`panes`, built once). */
export function Tiles(props: { tiles: Tiles; panes: Record<Tile, () => JSX.Element> }) {
  const panes = untrack(() => props.panes);
  return (
    <Tiling tiling={props.tiles}>
      <For each={TILES}>
        {(tile) => (
          <Tiling.Tile tileId={tile} id={IDS[tile]} aria-label={LABELS[tile]}>
            {untrack(panes[tile])}
            <Tiling.Grip title={`Drag to move ${LABELS[tile]}`}>
              <i class="i-lucide-move" aria-hidden="true" />
            </Tiling.Grip>
            <Tiling.Corner />
          </Tiling.Tile>
        )}
      </For>
      <Tiling.Handles aria-label="Resize panels" />
      <Tiling.DropIndicator />
    </Tiling>
  );
}
