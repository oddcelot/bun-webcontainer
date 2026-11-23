import { For, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Tiling, createTiling, isTilingLayout, setShare, type TilingLayout, type TilingState } from "@runbun/ui/solid/Tiling";
import type { Sized } from "../projectConfig";
import type { TilingCommand } from "../keymap";
import { pref } from "../prefs";

/**
 * The playground's panels in the tiling layout (a prototype; `?layout=tiling` or the command palette turns it on):
 * the four panels as tiles of `@runbun/ui`'s Tiling, the layout kept in localStorage, and the keymap's tiling
 * commands run on it.
 */

export const TILES = ["files", "editor", "preview", "console"] as const;
export type Tile = (typeof TILES)[number];
export type Tiles = ReturnType<typeof createTiles>;

/** The ids the classic layout's panels have, which style.css and the scripts know them by. */
const IDS: Record<Tile, string> = { files: "tree-panel", editor: "editor-panel", preview: "preview-panel", console: "console-wrap" };
const LABELS: Record<Tile, string> = { files: "Files", editor: "Editor", preview: "Preview", console: "Console" };

/** The classic arrangement: files, editor, preview over console. */
const START: TilingLayout<Tile> = {
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

/** The panels' layout, kept across reloads. Create it in the component that renders `<Tiles>`. */
export function createTiles() {
  const [stored, store] = pref<TilingLayout<Tile>>("layout.tiles", START, {
    deserialize(data) {
      const layout: unknown = JSON.parse(data);
      if (!isTilingLayout(layout, TILES)) throw new Error("layout.tiles: not a layout of the panels");
      return layout;
    },
  });
  // Read once, like the classic layout's sizes: each tab keeps its own layout while open.
  let own = untrack(stored);
  let shares: Partial<Record<Sized, number>> | null = null;
  // The inset is the gap the classic panels' borders leave around them all.
  const tiling = createTiling({
    tiles: TILES,
    defaultLayout: START,
    initialLayout: own,
    initialFocus: "editor",
    onLayoutChange(layout) {
      store((own = layout));
    },
    gap: 8,
    inset: 4,
  });
  return Object.assign(tiling, {
    /**
     * A project's runbun.json `sizes` (percent; null: none): the reader's layout with those shares, for as long as
     * the project is open. Not kept, unless the reader changes the layout from there.
     */
    sizes(next: Partial<Record<Sized, number>> | null) {
      if (!next && !shares) return;
      shares = next;
      tiling.show(next ? withShares(own, next) : own);
    },
  });
}

/**
 * The layout with a project's `sizes`, which name the classic columns: the file tree's and the editor's share of
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
