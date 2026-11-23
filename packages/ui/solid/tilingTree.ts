/**
 * The tiling layout's model (Tiling.tsx draws it): a binary tree of splits with the panels as its leaves, as in
 * Hyprland's dwindle layout. Everything here is pure: an operation returns a new tree, and `layout` turns a tree into
 * one rectangle per panel, so the panels themselves never move in the DOM (a moved iframe reloads).
 */

/** `row` puts `a` left of `b`, `col` puts it above. */
export type Axis = "row" | "col";
/**
 * `ratio` is `a`'s share of the room the two have, less the gap. With `fixed`, that side keeps `size` pixels
 * instead (a sidebar, a console's row) and the other gets the rest, whatever the room's size.
 */
export type Split = { axis: Axis; ratio: number; a: Tree; b: Tree; fixed?: Fixed };
export type Fixed = { side: "a" | "b"; size: number };
/** A panel's name, or two trees side by side. */
export type Tree = string | Split;
export type Rect = { x: number; y: number; w: number; h: number };
export type Dir = "left" | "right" | "up" | "down";
/** The draggable border of the split at `path` (`a`/`b` steps from the root), with the box its two sides share. */
export type Handle = { path: string; axis: Axis; rect: Rect; box: Rect };

const MIN_RATIO = 0.08;
export const clampRatio = (ratio: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
const axisOf = (dir: Dir): Axis => (dir === "left" || dir === "right" ? "row" : "col");
const before = (dir: Dir) => dir === "left" || dir === "up";
/** `a`'s pixels of the `total` the split's two sides have. */
const firstOf = (split: Split, total: number) => {
  if (!split.fixed) return Math.round(total * split.ratio);
  const size = Math.min(Math.max(0, total), split.fixed.size);
  return Math.round(split.fixed.side === "a" ? size : total - size);
};

export function leaves(tree: Tree | null): string[] {
  if (tree === null) return [];
  return typeof tree === "string" ? [tree] : [...leaves(tree.a), ...leaves(tree.b)];
}

/** The steps from the root to `tile`, or undefined if it isn't in the tree. */
export function pathTo(tree: Tree | null, tile: string): string | undefined {
  if (tree === null) return undefined;
  if (typeof tree === "string") return tree === tile ? "" : undefined;
  const a = pathTo(tree.a, tile);
  if (a !== undefined) return "a" + a;
  const b = pathTo(tree.b, tile);
  return b === undefined ? undefined : "b" + b;
}

function at(tree: Tree, path: string): Tree {
  let node = tree;
  for (const step of path) {
    if (typeof node === "string") throw new Error(`no split at ${path}`);
    node = node[step as "a" | "b"];
  }
  return node;
}

function replaceAt(tree: Tree, path: string, change: (node: Tree) => Tree): Tree {
  if (!path) return change(tree);
  if (typeof tree === "string") throw new Error(`no split at ${path}`);
  const step = path[0] as "a" | "b";
  return { ...tree, [step]: replaceAt(tree[step], path.slice(1), change) };
}

/**
 * Where everything goes in `box`: a rectangle per shown panel, and a handle per split with both sides showing. A
 * split with one side all hidden gives the other its whole box, so a hidden panel comes back where it was.
 */
export function layout(tree: Tree | null, box: Rect, gap: number, hidden: ReadonlySet<string> = new Set()): { rects: Map<string, Rect>; handles: Handle[] } {
  const rects = new Map<string, Rect>();
  const handles: Handle[] = [];
  const shows = (node: Tree): boolean => (typeof node === "string" ? !hidden.has(node) : shows(node.a) || shows(node.b));
  const place = (node: Tree, box: Rect, path: string) => {
    if (typeof node === "string") {
      if (!hidden.has(node)) rects.set(node, box);
      return;
    }
    const [a, b] = [shows(node.a), shows(node.b)];
    if (!a || !b) {
      if (a) place(node.a, box, path + "a");
      if (b) place(node.b, box, path + "b");
      return;
    }
    if (node.axis === "row") {
      const w = firstOf(node, box.w - gap);
      place(node.a, { ...box, w }, path + "a");
      place(node.b, { ...box, x: box.x + w + gap, w: box.w - w - gap }, path + "b");
      handles.push({ path, axis: "row", rect: { x: box.x + w, y: box.y, w: gap, h: box.h }, box });
    } else {
      const h = firstOf(node, box.h - gap);
      place(node.a, { ...box, h }, path + "a");
      place(node.b, { ...box, y: box.y + h + gap, h: box.h - h - gap }, path + "b");
      handles.push({ path, axis: "col", rect: { x: box.x, y: box.y + h, w: box.w, h: gap }, box });
    }
  };
  if (tree !== null) place(tree, box, "");
  return { rects, handles };
}

export function setRatio(tree: Tree, path: string, ratio: number): Tree {
  return replaceAt(tree, path, (node) => (typeof node === "string" ? node : { ...node, ratio: clampRatio(ratio) }));
}

/**
 * Gives the split at `path`'s first side `first` of the `total` pixels its two sides have: as a ratio, or for a
 * fixed split as its side's pixels.
 */
export function setFirst(tree: Tree, path: string, first: number, total: number): Tree {
  return replaceAt(tree, path, (node) => {
    if (typeof node === "string" || total <= 0) return node;
    const ratio = clampRatio(first / total);
    return node.fixed ? { ...node, ratio, fixed: { ...node.fixed, size: Math.round(node.fixed.side === "a" ? first : total - first) } } : { ...node, ratio };
  });
}

/** The tree without `tile`: its sibling takes the room of both. */
export function remove(tree: Tree | null, tile: string): Tree | null {
  if (tree === null || tree === tile) return null;
  if (typeof tree === "string") return tree;
  const [a, b] = [remove(tree.a, tile), remove(tree.b, tile)];
  if (a === null) return b;
  if (b === null) return a;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** Splits `target` along `axis` and puts `tile` in the half before it (`first`) or after it. */
export function insert(tree: Tree | null, tile: string, target: string, axis: Axis, first: boolean, ratio = 0.5): Tree {
  if (tree === null) return tile;
  const path = pathTo(tree, target);
  if (path === undefined) return { axis, ratio, a: first ? tile : tree, b: first ? tree : tile };
  return replaceAt(tree, path, (node) => ({ axis, ratio, a: first ? tile : node, b: first ? node : tile }));
}

/** Dwindle's rule for a new window: it takes the second half of `target`, split along its longer side. */
export function dwindle(tree: Tree | null, tile: string, target: string, rect: Rect | undefined): Tree {
  return insert(tree, tile, target, !rect || rect.w >= rect.h ? "row" : "col", false);
}

/** `tile` along the whole of one edge, with `share` of the room. */
export function toEdge(tree: Tree | null, tile: string, dir: Dir, share = 0.3): Tree {
  const rest = remove(tree, tile);
  if (rest === null) return tile;
  const first = before(dir);
  return { axis: axisOf(dir), ratio: first ? share : 1 - share, a: first ? tile : rest, b: first ? rest : tile };
}

export function swap(tree: Tree, x: string, y: string): Tree {
  if (typeof tree === "string") return tree === x ? y : tree === y ? x : tree;
  return { ...tree, a: swap(tree.a, x, y), b: swap(tree.b, x, y) };
}

/** The panel next to `tile` on that side: the nearest one that overlaps it across the direction, the most overlap first. */
export function neighbor(rects: ReadonlyMap<string, Rect>, tile: string, dir: Dir): string | undefined {
  const from = rects.get(tile);
  if (!from) return undefined;
  const horizontal = axisOf(dir) === "row";
  let best: { tile: string; distance: number; overlap: number } | undefined;
  for (const [other, r] of rects) {
    if (other === tile) continue;
    const distance = dir === "left" ? from.x - (r.x + r.w) : dir === "right" ? r.x - (from.x + from.w) : dir === "up" ? from.y - (r.y + r.h) : r.y - (from.y + from.h);
    const overlap = horizontal ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y) : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
    if (distance < -1 || overlap <= 0) continue;
    if (!best || distance < best.distance - 1 || (Math.abs(distance - best.distance) <= 1 && overlap > best.overlap)) best = { tile: other, distance, overlap };
  }
  return best?.tile;
}

/**
 * Moves `tile` one step. A sibling on that side trades places with it, each keeping its size. Another neighbor as
 * long as the tile on the facing side is passed too; a longer one (the editor beside the console under the preview)
 * gets the tile next to it first, at its full length. With no neighbor there, the tile takes the whole of that edge.
 */
export function move(tree: Tree, tile: string, dir: Dir, rects: ReadonlyMap<string, Rect>): Tree {
  const path = pathTo(tree, tile);
  if (path === undefined || typeof tree === "string") return tree;
  const axis = axisOf(dir);
  const next = neighbor(rects, tile, dir);
  if (next === undefined) {
    // Already along that edge.
    if (tree.axis === axis && (before(dir) ? tree.a : tree.b) === tile) return tree;
    return toEdge(tree, tile, dir);
  }
  const parent = at(tree, path.slice(0, -1)) as Split;
  const sibling = path.endsWith("a") ? parent.b : parent.a;
  if (sibling === next && parent.axis === axis) return replaceAt(tree, path.slice(0, -1), () => ({ ...parent, ratio: 1 - parent.ratio, a: parent.b, b: parent.a, ...(parent.fixed && { fixed: { ...parent.fixed, side: parent.fixed.side === "a" ? "b" : "a" } }) }));
  const [from, to] = [rects.get(tile)!, rects.get(next)!];
  const peers = axis === "row" ? Math.abs(from.y - to.y) <= 1 && Math.abs(from.h - to.h) <= 1 : Math.abs(from.x - to.x) <= 1 && Math.abs(from.w - to.w) <= 1;
  return insert(remove(tree, tile), tile, next, axis, peers ? before(dir) : !before(dir));
}

/** Turns the split `tile` is in: side by side becomes one over the other. */
export function toggleSplit(tree: Tree, tile: string): Tree {
  const path = pathTo(tree, tile);
  if (!path) return tree;
  return replaceAt(tree, path.slice(0, -1), (node) => (typeof node === "string" ? node : { ...node, axis: node.axis === "row" ? "col" : "row" }));
}

/** Grows `tile` by `delta` (a share; negative shrinks) within the nearest split whose other side shows. */
export function resize(tree: Tree, tile: string, delta: number, hidden: ReadonlySet<string> = new Set()): Tree {
  const path = pathTo(tree, tile);
  if (path === undefined) return tree;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const split = at(tree, path.slice(0, depth)) as Split;
    const other = path[depth] === "a" ? split.b : split.a;
    if (!leaves(other).some((t) => !hidden.has(t))) continue;
    return setRatio(tree, path.slice(0, depth), split.ratio + (path[depth] === "a" ? delta : -delta));
  }
  return tree;
}

/**
 * Gives `tile`'s side of the nearest split along `axis` around it that `share` (0 to 1) of the split's room, as a
 * ratio. The tree as it is if no such split holds the tile.
 */
export function setShare(tree: Tree, tile: string, axis: Axis, share: number): Tree {
  const path = pathTo(tree, tile);
  if (path === undefined) return tree;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    if ((at(tree, path.slice(0, depth)) as Split).axis !== axis) continue;
    return replaceAt(tree, path.slice(0, depth), (node) => {
      const { fixed: _, ...split } = node as Split;
      return { ...split, ratio: clampRatio(path[depth] === "a" ? share : 1 - share) };
    });
  }
  return tree;
}

/** Whether `value` is a tree of exactly `tiles`, each once. */
export function isTreeOf(value: unknown, tiles: readonly string[]): value is Tree | null {
  const seen: string[] = [];
  const ok = (node: unknown): boolean => {
    if (typeof node === "string") return seen.push(node) > 0;
    if (typeof node !== "object" || node === null) return false;
    const s = node as Partial<Split>;
    const fixed = s.fixed === undefined || (typeof s.fixed === "object" && s.fixed !== null && (s.fixed.side === "a" || s.fixed.side === "b") && typeof s.fixed.size === "number" && s.fixed.size >= 0);
    return (s.axis === "row" || s.axis === "col") && typeof s.ratio === "number" && s.ratio > 0 && s.ratio < 1 && fixed && ok(s.a) && ok(s.b);
  };
  if (value !== null && !ok(value)) return false;
  return seen.length === tiles.length && tiles.every((t) => seen.includes(t));
}
