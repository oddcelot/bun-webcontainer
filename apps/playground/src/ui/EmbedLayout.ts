import type { Tree } from "@runbun/ui/solid/Tiling";
import { STACK_CONSOLE } from "../embed/config";
import type { Sized } from "../projectConfig";

/**
 * The embed's arrangement as a tree for @runbun/ui's Tiling (ui/EmbedApp.tsx draws it): which panes there are and
 * where is the author's and the frame's to say (mode, features, `layout`, how wide the frame is), so the tree is built
 * from those and built again when they change. A reader only drags the borders; what they dragged is kept by the
 * border's name, to hold through every arrangement that has it.
 */

export const PANES = ["tree", "editor", "preview", "console"] as const;
export type Pane = (typeof PANES)[number];

/**
 * What a reader can resize: the tree's width, the editor's share beside the side column (`side`), over it stacked
 * (`stack`) or in a narrow frame (`narrow`), the preview's over the console (`rows`), the console's height under the
 * rest, and the height of the row under a stacked editor in a frame that fits its content (`fit`). Pixels for `tree`,
 * `console` and `fit`, a share (0 to 1) for the others.
 */
export type Size = "tree" | "side" | "rows" | "console" | "stack" | "fit" | "narrow";
export type Sizes = Partial<Record<Size, number>>;
const IN_PIXELS: Record<Size, "first" | "second" | undefined> = { tree: "first", console: "second", fit: "second", side: undefined, rows: undefined, stack: undefined, narrow: undefined };

/** What the arrangement depends on. */
export type Shape = {
  /** An editor (not result mode). */
  editor: boolean;
  /** The file tree as a pane (as a drawer, it is out of the arrangement). */
  tree: boolean;
  /** A column beside the editor: the preview, or the console in console mode. */
  side: boolean;
  /** `layout=stack`: that column under the editor. */
  stacked: boolean;
  /** The frame is as tall as the embed asked, so stacked rows fit their content. */
  fit: boolean;
  /** A narrow frame: the side column goes under the editor. */
  narrow: boolean;
  preview: boolean;
  console: boolean;
  /** The stacked preview's height in a fitted frame. */
  fitPreview: number;
  /** The project's runbun.json `sizes` (percent), under what the reader dragged. */
  shares?: Partial<Record<Sized, number>>;
};

const TREE_WIDTH = 170;
/** The console under the editor (code mode). */
const CONSOLE_BELOW = 150;

type How = { ratio: number } | { side: "a" | "b"; size: number };
type Node = Pane | { name: Size; label: string; axis: "row" | "col"; a: Node; b: Node; how: How };
export type Built = { tree: Tree | null; shown: Pane[]; names: Record<string, Size>; labels: Record<string, string> };

const within = (ratio: number) => Math.min(0.92, Math.max(0.08, ratio));
const share = (percent: number | undefined) => (percent === undefined ? undefined : within(percent / 100));

/** The tree for `shape`, with the reader's `sizes`; `names` and `labels` are its borders' by their path in the tree. */
export function buildLayout(shape: Shape, sizes: Sizes): Built {
  const { shares } = shape;
  const split = (name: Size, label: string, axis: "row" | "col", a: Node, b: Node, how: How): Node => ({ name, label, axis, a, b, how });
  /** A share: the reader's, the project's, the usual. */
  const ratio = (name: Size, usual: number, percent?: number): How => ({ ratio: within(sizes[name] ?? share(percent) ?? usual) });
  /** The second side's pixels: the reader's, else the project's share of the two, else the usual. */
  const second = (name: Size, usual: number, percent?: number): How => {
    const first = sizes[name] === undefined ? share(percent) : undefined;
    return first === undefined ? { side: "b", size: sizes[name] ?? usual } : { ratio: first };
  };
  const withTree = (rest: Node): Node => {
    if (!shape.tree) return rest;
    const files = sizes.tree === undefined ? share(shares?.files) : undefined;
    return split("tree", "Resize file tree", "row", "tree", rest, files === undefined ? { side: "a", size: sizes.tree ?? TREE_WIDTH } : { ratio: files });
  };
  const rows = () => split("rows", "Resize preview and console", "col", "preview", "console", ratio("rows", 0.6, shares?.preview));
  const both = shape.preview && shape.console;

  let root: Node | null;
  if (!shape.editor) root = both ? rows() : shape.preview ? "preview" : shape.console ? "console" : null;
  else if (!shape.side) root = withTree(shape.console ? split("console", "Resize editor and console", "col", "editor", "console", second("console", CONSOLE_BELOW, shares?.editor)) : "editor");
  else {
    const under: Pane = shape.preview ? "preview" : "console";
    const label = `Resize editor and ${under}`;
    if (shape.stacked || shape.narrow) {
      // The editor (with the tree beside it, where a stacked frame has the room) over the rest, and the console last.
      const top = shape.stacked ? withTree("editor") : "editor";
      const main = !shape.stacked
        ? split("narrow", label, "col", top, under, ratio("narrow", 0.5))
        : shape.fit
          ? split("fit", label, "col", top, under, { side: "b", size: sizes.fit ?? (shape.preview ? shape.fitPreview : STACK_CONSOLE) })
          : split("stack", label, "col", top, under, ratio("stack", 0.55, shares?.editor));
      root = both ? split("console", "Resize preview and console", "col", main, "console", { side: "b", size: sizes.console ?? STACK_CONSOLE }) : main;
    } else root = withTree(split("side", label, "row", "editor", both ? rows() : under, ratio("side", 0.5, shares?.editor)));
  }

  const built: Built = { tree: null, shown: [], names: {}, labels: {} };
  const finish = (node: Node, path: string): Tree => {
    if (typeof node === "string") return built.shown.push(node), node;
    built.names[path] = node.name;
    built.labels[path] = node.label;
    const [a, b] = [finish(node.a, path + "a"), finish(node.b, path + "b")];
    return "ratio" in node.how ? { axis: node.axis, ratio: node.how.ratio, a, b } : { axis: node.axis, ratio: 0.5, fixed: node.how, a, b };
  };
  if (root !== null) built.tree = finish(root, "");
  return built;
}

/** The sizes the reader dragged, kept for the tab in sessionStorage under `key` (theme.ts: nothing in localStorage). */
export function createSizes(key: string) {
  let current: Sizes = {};
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (typeof kept === "object" && kept !== null) for (const [name, value] of Object.entries(kept)) if (name in IN_PIXELS && typeof value === "number" && value > 0) current[name as Size] = value;
  } catch {}
  let saving: ReturnType<typeof setTimeout> | undefined;
  // Once a drag rests: it sets a size per pointer move.
  const save = () => {
    clearTimeout(saving);
    saving = setTimeout(() => {
      try {
        sessionStorage.setItem(key, JSON.stringify(current));
      } catch {}
    }, 150);
  };
  return {
    get: () => current,
    /** The border named `name` was moved: its two sides now have these pixels. */
    moved(name: Size, size: { first: number; second: number }) {
      const pixels = IN_PIXELS[name];
      current = { ...current, [name]: pixels ? size[pixels] : size.first / Math.max(1, size.first + size.second) };
      save();
    },
    /** Back to the usual. */
    reset(name: Size) {
      const { [name]: _, ...rest } = current;
      current = rest;
      save();
    },
  };
}
