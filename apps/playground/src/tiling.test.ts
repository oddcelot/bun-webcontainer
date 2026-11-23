// node apps/playground/src/tiling.test.ts   (node >= 26 runs the TypeScript directly)
import assert from "node:assert/strict";
import { dwindle, insert, isTreeOf, layout, leaves, move, neighbor, remove, resize, setRatio, swap, toEdge, toggleSplit, type Tree } from "./tiling.ts";

const BOX = { x: 0, y: 0, w: 1008, h: 608 };
// files | editor | preview over console
const START: Tree = { axis: "row", ratio: 0.2, a: "files", b: { axis: "row", ratio: 0.5, a: "editor", b: { axis: "col", ratio: 0.5, a: "preview", b: "console" } } };
const rectsOf = (tree: Tree, hidden: string[] = []) => layout(tree, BOX, 8, new Set(hidden)).rects;

// Layout: the gaps come out of the room, and the rectangles tile the box.
{
  const { rects, handles } = layout(START, BOX, 8);
  assert.deepEqual(rects.get("files"), { x: 0, y: 0, w: 200, h: 608 });
  assert.deepEqual(rects.get("editor"), { x: 208, y: 0, w: 396, h: 608 });
  assert.deepEqual(rects.get("preview"), { x: 612, y: 0, w: 396, h: 300 });
  assert.deepEqual(rects.get("console"), { x: 612, y: 308, w: 396, h: 300 });
  assert.deepEqual(handles.map((h) => h.path).sort(), ["", "b", "bb"]);
}

// A hidden panel gives its sibling the room and keeps its place in the tree.
{
  const { rects, handles } = layout(START, BOX, 8, new Set(["preview", "files"]));
  assert.equal(rects.has("preview"), false);
  assert.deepEqual(rects.get("console"), { x: 508, y: 0, w: 500, h: 608 });
  assert.deepEqual(rects.get("editor"), { x: 0, y: 0, w: 500, h: 608 });
  assert.deepEqual(handles.map((h) => h.path), ["b"]);
  assert.equal(layout(START, BOX, 8, new Set(["preview", "console"])).rects.get("editor")!.w, 800);
}

// Neighbors by geometry.
{
  const rects = rectsOf(START);
  assert.equal(neighbor(rects, "editor", "left"), "files");
  assert.equal(neighbor(rects, "console", "left"), "editor");
  assert.equal(neighbor(rects, "console", "up"), "preview");
  assert.equal(neighbor(rects, "console", "down"), undefined);
  assert.equal(neighbor(rects, "files", "right"), "editor");
  assert.ok(["preview", "console"].includes(neighbor(rects, "editor", "right")!));
}

// remove / insert / dwindle / swap keep every panel exactly once.
{
  const without = remove(START, "preview")!;
  assert.deepEqual(leaves(without), ["files", "editor", "console"]);
  assert.deepEqual(leaves(insert(without, "preview", "files", "col", true)), ["preview", "files", "editor", "console"]);
  const wide = dwindle(without, "preview", "editor", { x: 0, y: 0, w: 400, h: 300 });
  assert.deepEqual(rectsOf(wide).get("preview")!.h, 608);
  const tall = dwindle(without, "preview", "editor", { x: 0, y: 0, w: 300, h: 400 });
  assert.ok(rectsOf(tall).get("preview")!.h < 608);
  assert.deepEqual(leaves(swap(START, "files", "console")), ["console", "editor", "preview", "files"]);
  assert.equal(remove("files", "files"), null);
  assert.equal(insert(null, "files", "x", "row", true), "files");
}

// move: siblings trade places and keep their sizes; a longer neighbor gets the panel beside it, an equal one is passed; at an edge it takes the edge.
{
  let tree = move(START, "console", "up", rectsOf(START));
  assert.deepEqual(leaves(tree), ["files", "editor", "console", "preview"]);
  tree = setRatio(START, "bb", 0.25);
  const h = rectsOf(tree).get("console")!.h;
  tree = move(tree, "console", "up", rectsOf(tree));
  assert.equal(rectsOf(tree).get("console")!.h, h);
  assert.equal(rectsOf(tree).get("console")!.y, 0);

  tree = move(START, "console", "left", rectsOf(START));
  assert.deepEqual(leaves(tree), ["files", "editor", "console", "preview"]);
  assert.equal(rectsOf(tree).get("console")!.h, 608);
  tree = move(tree, "console", "left", rectsOf(tree));
  assert.deepEqual(leaves(tree), ["files", "console", "editor", "preview"]);
  tree = move(tree, "console", "left", rectsOf(tree));
  assert.deepEqual(leaves(tree), ["console", "files", "editor", "preview"]);
  // Now along the left edge already: nothing changes.
  const edge = move(tree, "console", "left", rectsOf(tree));
  assert.deepEqual(rectsOf(edge).get("console")!.x, 0);

  tree = move(START, "console", "down", rectsOf(START));
  assert.deepEqual(rectsOf(tree).get("console"), { x: 0, y: 428, w: 1008, h: 180 });
  assert.equal(move(tree, "console", "down", rectsOf(tree)), tree);
  assert.deepEqual(leaves(toEdge(START, "files", "right")), ["editor", "preview", "console", "files"]);
}

// toggleSplit and resize.
{
  const turned = toggleSplit(START, "console");
  assert.equal(rectsOf(turned).get("console")!.h, 608);
  const grown = resize(START, "console", 0.1);
  assert.ok(rectsOf(grown).get("console")!.h > 300);
  // With the preview hidden, the console grows against the editor instead.
  const wider = resize(START, "console", 0.1, new Set(["preview"]));
  assert.ok(rectsOf(wider, ["preview"]).get("console")!.w > rectsOf(START, ["preview"]).get("console")!.w);
  assert.ok((setRatio(START, "", 5) as { ratio: number }).ratio < 1);
}

// Validation of a stored tree.
{
  const tiles = ["files", "editor", "preview", "console"];
  assert.ok(isTreeOf(START, tiles));
  assert.ok(isTreeOf(remove(START, "files"), ["editor", "preview", "console"]));
  assert.ok(isTreeOf(null, []));
  assert.equal(isTreeOf(remove(START, "files"), tiles), false);
  assert.equal(isTreeOf({ axis: "row", ratio: 0.5, a: "files", b: "files" }, ["files"]), false);
  assert.equal(isTreeOf({ axis: "diag", ratio: 0.5, a: "files", b: "editor" }, ["files", "editor"]), false);
  assert.equal(isTreeOf({ axis: "row", ratio: 2, a: "files", b: "editor" }, ["files", "editor"]), false);
}

console.log("tiling: ok");
