# @runbun/ui

The design system the playground (`apps/playground`) and the docs (`apps/docs`) share. Private, used through
`workspace:*`, shipped as source.

## What's in it

- **Tokens** (`uno.preset.ts`): the UnoCSS preset both apps load. It defines the CSS variables (`--bg`, `--fg`,
  `--panel`, `--accent`, `--control`, `--control-border`, `--pad`, `--radius`, `--inner-radius`, `--control-height`,
  …) and utilities over them (`bg-panel`, `text-muted`, `rounded-pane`). `families: true` adds every theme family's
  colors under `[data-family]`.
- **Theme data** (`themes.json`, `code-themes/`): the families and each theme's chrome colors, written by
  `apps/playground/scripts/theme-swatches.ts` (`cd apps/playground && bun run swatches`).
- **Components** (`solid/*.tsx`): Solid 2 components over Kobalte 2 (`@kobalte/core`).
- **Styles** (`css/*.css`): one stylesheet per component.

## Using a component

```tsx
import { Segmented } from "@runbun/ui/solid/Segmented";
```

Each component imports its own stylesheet, so using one brings only its styles. The rules are in the cascade layer
`runbun-ui`, so any rule of the app's (a UnoCSS utility included) overrides them, whatever its specificity or load
order: restyle a component by targeting its class. The flip side: a broad app rule (`header button`) reaches into
components too; scope it (`header button:not(.select-trigger)`). Markup that uses a component's classes
without the component (a raw Kobalte part, say) imports the stylesheet itself: `@import "@runbun/ui/css/select.css";`
in CSS, or `import "@runbun/ui/css/select.css";` in a module.

What an app needs:

- A Solid 2 Vite plugin that compiles `.tsx` from this package (the playground's `@solidjs/vite-plugin`; the docs get
  one from `@astrojs/solid-js`). The package is linked outside `node_modules`, so Vite treats it as source.
- The uno preset (`uiPreset()` in the app's `uno.config.ts`), for the tokens the stylesheets use. Colors come from
  those variables only, so a page sets its theme by setting them.
- `presetIcons({ mode: "mask" })` with `@iconify-json/lucide`: components use `i-lucide-*` icon classes, which the
  app's UnoCSS generates when it scans them.
- The peers `solid-js`, `@solidjs/web` and `@kobalte/core`, from the root catalog.

Popups (menus, tooltips, the appearance popover) portal to `<body>`, or into the top-layer element (`[popover]`,
`<dialog>`) their trigger sits in (`solid/layer.ts`). They set their own font size, `--ui-font-size` (13px unless set),
since they don't inherit the page's.

## Components

| Component | File | What it is |
|---|---|---|
| `Button` | `solid/Button.tsx` | A control-height button; `primary` for a group's main action |
| `Select` | `solid/Select.tsx` | A button opening a list of choices (flat or in sections), with optional leading content |
| `Menu`, `MenuItem`, `MenuCheckItem`, `MenuGroup`, `MenuSeparator`, `MenuTrigger` | `solid/Menu.tsx` | A dropdown of actions and toggles |
| `Dialog`, `DialogTitle`, `DialogDescription`, `DialogActions`, `DialogClose`, `DialogTrigger` | `solid/Dialog.tsx` | A modal: overlay, box and its parts |
| `Input` | `solid/Input.tsx` | A text field; `multiline` for a textarea |
| `PathInput` | `solid/PathInput.tsx` | One path, typed or picked from suggestions (a combobox) |
| `Field` | `solid/Field.tsx` | A label (and hint) over its control |
| `Segmented` | `solid/Segmented.tsx` | One of a few values, as a row of buttons |
| `Chips`, `Chip` | `solid/Chips.tsx` | Any number of values, as a wrapping row of toggles |
| `TabList`, `TabItem` | `solid/Tabs.tsx` | A row of tabs; selection is the caller's |
| `Tip` | `solid/Tip.tsx` | A tooltip on hover and keyboard focus, with optional shortcut keys |
| `Swatch` | `solid/Swatch.tsx` | A theme family's light and dark halves |
| `FamilyListbox` | `solid/FamilyListbox.tsx` | The theme families as a grouped list with swatches |
| `Tiling` (`.Tile`, `.Grip`, `.Corner`, `.Handles`, `.DropIndicator`), `createTiling` | `solid/Tiling.tsx` | A tiling layout over a split tree (`solid/tilingTree.ts`): tiles moved by direction or by dragging, resized, maximized, floated, hidden, without ever moving in the DOM, or a layout the caller decides and a reader only resizes (`movable: false`; the embed); the layout and its commands are the caller's `createTiling` state |
| `AppearancePicker` | `solid/AppearancePicker.tsx` | Color scheme and theme family, with live preview; state is the caller's |

State stays with the caller: components take values and callbacks (`value`/`onChange`, or `AppearancePicker`'s
`mode`/`family`/`setMode`/`preview`/`pick`), so each app connects them to its own store.

## Adding a component

Put it in `solid/<Name>.tsx` and its rules in `css/<name>.css` inside `@layer runbun-ui { }`, imported at the top of
the component. Nest the rules: one block per root class, with its states, parts and variants inside (see AGENTS.md).
Write them over the preset's variables, with no hard-coded colors. Keep the component free of app imports: anything
app-specific comes in through props.

## The retro layer

`css/retro.css` is the 8-bit look of the landing page and the docs (not the playground app, which doesn't import it):
`.retro-frame` (a notched pixel border), `.retro-shadow` (with a solid offset shadow), `.retro-dialog` (an RPG dialog
box with a blinking caret), `.retro-button` (a menu button; `.primary`), `.retro-title` (display type) and
`.retro-sprite` (a face of `assets/dumplings.png`, picked with `--x`/`--y`). The rules are in the cascade layer
`runbun-retro`, so app rules win.

The colors are the theme's, so the parts follow the family and scheme. A scope can pin them with `--retro-ink`,
`--retro-fill`, `--retro-rim`, `--retro-shade` and `--retro-hi` on an ancestor; don't set those on `:root` as
`var(--…)`, or they keep the root's colors under a scope that overrides the tokens. The preset adds `--px` (one art
pixel), `--font-pixel` (Pixelify Sans) and `--font-pixel-label` (Press Start 2P); each app loads the fonts it uses
from `@fontsource`.
