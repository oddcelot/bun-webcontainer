# Panel layout: strategies for a Hyprland-style rework

Status: exploration plus a working prototype of strategy A on the `probe/tiling-layout` branch (2026-11-24).
Nothing here is decided; this file is for judging the options.

## Where the layout is today

`src/ui/App.tsx` nests two Kobalte `Resizable` roots: files | editor | (preview over console). That is the only
arrangement there is.

- A panel can be resized or hidden (its size set to 0). It cannot be moved, swapped, stacked differently, maximized
  (only the preview has its own "expand") or floated.
- Console, Devtools and Debug share one dock as tabs. Files and Git share the tree's column. Changes is a pseudo-tab
  of the editor.
- Sizes are two arrays in localStorage (`layout.columns`, `layout.right`). `runbun.json` can override shown panels
  and sizes per project, in terms of those three columns.
- The embed (`ui/EmbedApp.tsx`) had its own CSS-grid layout. It now draws its panes with the same `Tiling` component,
  as a layout it decides itself; see "The embed" below. Whether a reader may rearrange an embed is not part of this
  question.

The hard constraint for any rework: **panels must not be moved in the DOM or remounted.** A moved iframe reloads
(the preview, the devtools frame), the xterm terminal does not survive a remount, and the editor is an imperative
island too. `Element.moveBefore()` would preserve them but Safari does not ship it.

## What "like Hyprland" means here

Hyprland's dwindle layout is a binary tree: every window is a leaf, a new window splits the focused one along its
longer side, and closing one gives its sibling the room. On top of that sit the dispatchers: focus, move and swap by
direction, resize, toggle the split's direction, maximize, float, groups (tabbed windows in one tile), a scratchpad.
The compositor draws windows wherever the tree says; windows themselves never know.

That last point maps directly onto the constraint above: keep the panels as flat siblings and let a tree decide
their rectangles.

## Strategies

### A. Own split tree over a flat panel list (prototyped)

A pure module (`packages/ui/solid/tilingTree.ts`, about 200 lines) holds the binary tree and its operations; a
component (`packages/ui/solid/Tiling.tsx`) renders the panels as absolutely positioned siblings in a fixed DOM order and gives each the
rectangle the tree works out. Rearranging changes four CSS properties per panel and nothing else.

- **For:** exactly the Hyprland model, including the things no library has (dwindle insertion, directional
  focus/move, turning a split). Nothing reloads, in every browser, by construction. Animation is a CSS transition on
  the rectangle. No dependency; removes the Kobalte `Resizable` workarounds in `App.tsx` once classic goes.
  Layouts serialize as a small JSON tree.
- **Against:** everything beyond the tree is ours to write and maintain: drag and drop, floating, later groups.
  Accessibility of the resize borders has to be redone (the prototype has keyboard-resizable separators, not yet
  the ARIA value attributes Kobalte gives).
- **Effort:** prototype done. To ship: per-project `sizes`, a mobile fallback, docs, polish. See "Open questions".

### B. dockview-core (the VS Code style docking library)

Vanilla, MIT, actively maintained (8.9.1, Nov 2026), about 91 kB gzipped. Gives a grid of split views with tab
groups, drag and drop with drop zones, floating and pop-out windows, and JSON layouts. Its `renderer: "always"` mode
keeps panel content alive (hidden with `visibility`), which is how it avoids reloading iframes.

- **For:** the most features for the least code of ours; tab groups and pop-out windows come for free; a familiar
  IDE feel.
- **Against:** it is a docking model, not a tiling one: every panel gets a tab header, panels are placed by
  explicit position, there is no auto-tiling and no keyboard direction commands, so the Hyprland part would be a
  layer we write on top of its API anyway. No Solid 2 wrapper exists (the two Solid wrappers are Solid 1 only), so
  each panel is bridged by hand. Its look has to be re-themed to match the cards-with-gaps design. Largest bundle
  cost of the options.
- **Effort:** medium to integrate, then ongoing friction where its model and the tiling model disagree.

### C. Generate nested `Resizable` splitters from a tree

Keep Kobalte's `Resizable` (or a Solid 2 port of corvu's) and render it recursively from the same kind of tree.

- **For:** reuses the splitter behavior and accessibility already in the app.
- **Against:** panels live inside the nesting, so changing the tree's shape reparents them: the preview reloads and
  the terminal dies on every move, unless each panel is portalled out of the tree, at which point this is strategy A
  with an extra library in the middle. Kobalte's `Resizable` already needs three workarounds here for a fixed
  layout. Not recommended.

### D. Named presets on CSS grid

A handful of fixed arrangements (`grid-template-areas`): classic, console along the bottom, preview left, editor
only, a master/stack variant. A command or menu switches between them.

- **For:** smallest change, no reloads (grid areas only restyle), easy to make responsive, and the embed already
  works this way.
- **Against:** it is a picker, not a compositor: no free placement, no moving one panel, no floating. It likely does
  not answer "semi restrictive". Worth keeping in mind as a *feature of A* instead: presets are just stored trees.

### E. A plus the rest of Hyprland, in stages

Not an alternative to A but where it can go, each stage shippable alone:

1. **More tiles.** Today's four panels are the tiles. Splitting the dock so Console, Devtools and Debug are their
   own tiles, and Git its own beside Files, is where tiling starts to pay: with four tiles there are only so many
   layouts. This needs `Dock.tsx` and `Explorer.tsx` taken apart, and is the largest piece of real work.
2. **Groups.** A tile that holds several panels as tabs (Hyprland's `togglegroup`): the tree's leaf becomes a list
   plus an active index. This is also how the current dock would be expressed, so stage 1 does not have to remove
   the tabbed dock, only make it one possible arrangement.
3. **Presets and per-project layouts.** Stored trees with names; `runbun.json` gets a `layout` that is a tree, and
   today's `panels`/`sizes` map onto it.
4. **Scratchpad.** A floating panel toggled by one key (the console is the obvious one).
5. **Several editors.** Two editor tiles side by side. Needs the workspace to support more than one editor, which
   is a separate project.

## Recommendation

A, then E.1 and E.2 if the prototype feels right. B is the fallback if tabbed groups, pop-out windows and
drag-and-drop polish matter more than the tiling model, at the cost of bundle size and a model that fights the
Hyprland feel.

## The prototype (strategy A)

On by `?layout=tiling` in the URL (kept afterwards), or "Switch to the tiling layout" in the command palette
(Mod+Shift+P). "Switch to the classic layout" goes back. Switching reloads the page. The classic layout is
untouched and stays the default.

What works:

| Action | Keys (rebindable in the shortcuts dialog) | Mouse |
| --- | --- | --- |
| Focus the panel left/down/up/right | Ctrl+Alt+H/J/K/L or arrows | click |
| Move the panel | Ctrl+Alt+Shift+H/J/K/L or arrows | hold Alt: each panel shows a grip in its middle; drag that, or anywhere on the panel |
| Turn the panel's split | Ctrl+Alt+S | |
| Maximize / restore | Ctrl+Alt+F | |
| Float / tile again | Ctrl+Alt+V | Alt+drag a floating panel; resize by its corner |
| Hide the panel | Ctrl+Alt+C (Mod+B, Mod+J, Mod+Alt+B and the status bar still toggle) | |
| Grow / shrink | Ctrl+Alt+G / Ctrl+Alt+R | drag a border, or the spot where borders meet to move them all at once; double-click resets; arrows when focused |
| Reset the layout | palette: "Tiling: reset the layout" | |

- Moving by keyboard: a sibling in that direction trades places; a longer neighbor gets the panel beside it at full
  length; an equal one is passed; at the room's edge the panel takes the whole edge.
- Dropping by mouse: a side of another panel splits it there, its middle swaps the two, an edge of the room takes
  the whole edge. An outline shows where it will land. Escape cancels.
- A hidden panel keeps its place in the tree and comes back where it was.
- The keys also work with focus inside the preview's page (they are forwarded like the other window shortcuts).
- The layout is kept in localStorage (`layout.tiles`) and survives reloads.
- A project's `runbun.json` `panels` is honored (shown/hidden, not saved); its `sizes` is not, since it names the
  classic columns.

Verified by `scripts/tiling.ts` (headless Chrome, 17 checks against a running dev server): tiling, every command
above, the drag, the border resize, the reload, and that the preview's iframe fires no `load` after the run through
all of it. `packages/ui/solid/tilingTree.test.ts` covers the tree operations.

### The component

The layout is a component of `@runbun/ui` in the shape of a Kobalte one: parts under one name, state the caller's,
data attributes to style by, no app imports.

```tsx
const tiling = createTiling({ tiles: ["files", "editor"], defaultLayout, initialLayout: stored, onLayoutChange: save });

<Tiling tiling={tiling}>
  <Tiling.Tile tileId="files" aria-label="Files">
    <Files />
    <Tiling.Grip />
    <Tiling.Corner />
  </Tiling.Tile>
  <Tiling.Tile tileId="editor" aria-label="Editor">…</Tiling.Tile>
  <Tiling.Handles aria-label="Resize panels" />
  <Tiling.DropIndicator />
</Tiling>
```

- `createTiling` returns the state and the commands: `focusDirection`, `move`, `toggleSplit`, `toggleMaximized`,
  `toggleFloating`, `grow`, `setShown`/`toggle`, `override`/`reveal`, `reset`, `setLayout`, and the tracked
  `layout`, `focused`, `maximized`, `shown`. It knows nothing of keys: the playground maps its keymap onto it
  (`runTilingCommand` in `src/ui/Tiles.tsx`, which is now about 120 lines).
- Parts carry `data-tiling-*` and state attributes (`data-focused`, `data-hidden`, `data-floating`,
  `data-maximized`, `data-dragging`, `data-orientation`, `data-active`), and default classes styled by
  `css/tiling.css` in the `runbun-ui` layer, so an app rule overrides them.
- Where it differs from Kobalte: the state comes from `createTiling` rather than root props plus a children
  function, since commands run from outside the root (the keymap, the status bar) and Kobalte's function children
  need a workaround in Solid 2 as it is. The layout is uncontrolled (`initialLayout` + `onLayoutChange` +
  `setLayout`); a controlled `layout` prop and an `as` prop for the parts are not there yet.

### The embed

The embed uses `Tiling` as a renderer only: `ui/EmbedLayout.ts` builds the tree from the mode, the features, the
`layout` option and the frame's width (and builds it again when one changes), and `createTiling` gets
`movable: false, animated: false`. A reader drags the borders and no more: no keys, no grips, no floating. It replaced
the grid templates in `embed.css` and the embed's own splitter (`EmbedSplit.tsx`).

What it needed from the component, all of it there for the playground's tiling too:

- **Fixed splits.** A split's side can keep its pixels (`fixed: { side, size }`) instead of a share: the file tree's
  width, the console's row, the preview's row in a frame that fits its content. The playground's tiles are all shares
  so far; a sidebar that keeps its width as the window grows would be this.
- **`onSplitResize`, `onSplitReset`, `labelFor` on `Tiling.Handles`.** The embed keeps what a reader dragged by the
  border's name (so it holds when the arrangement changes), answers a double click with its own default, and names
  each separator.
- **`unplaced` on `Tiling.Tile`.** The file tree as a drawer over the editor is placed by the embed, not the tree.
- **A least size per direction**, and Home/End on a focused border.

`scripts/embed-layout.ts` checks it (headless Chrome, a running dev server): 22 arrangements, the borders, the
crossing, the keyboard, a reload, the drawer. Run against the grid it replaced, the panes' boxes were the same in 21;
the 22nd was the grid being 7px off in a narrow frame with a file tree.

Since then it is the default layout (`?layout=classic` or the palette goes back), and:

- **Keys:** one chord (Mod+K, `tileKeys`), then a key, with a hint listing them; the Ctrl+Alt chords are gone, since
  each collided with a window manager (Rectangle, GNOME) or an AltGr character.
- **Narrow windows** (under 700px) have a layout of their own, stacked, kept apart from the wide one.
- **A project's `sizes`** apply: each share goes to the nearest split along its axis around that tile.
- It is in the docs (playground/editor.md, "Panels").

Known gaps:

- Four tiles only (see E.1); the dock's tabs and Files/Git are as before.
- The grips only show while Alt is held with the keyboard's focus in the page itself: Alt pressed inside the preview's
  page doesn't reach it.
- The preview's own "expand" still exists next to "maximize"; one of them should go.
- The classic layout's code (Kobalte's splitter in App.tsx) is still there, behind the switch.

## Open questions

1. Is four tiles enough to judge, or does the dock need splitting (E.1) before this is convincing?
2. Should tiling replace the classic layout, or stay a mode? Replacing removes the Kobalte splitter code and the
   reload on switching; classic then becomes the default tree.
3. Are groups (tabbed tiles) wanted, or is "one panel per tile" the point?
4. Key bindings: a leader-key scheme (one prefix, then h/j/k/l) would avoid the modifier collisions.
5. What should `runbun.json` say: keep `panels`/`sizes` mapped onto the default tree, or add a `layout` tree?
