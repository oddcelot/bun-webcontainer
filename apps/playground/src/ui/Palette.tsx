import { For, Show, createMemo, createSignal, createUniqueId, untrack, useContext } from "solid-js";
import { Dialog as Kobalte } from "@kobalte/core/dialog";
import { chordKeys } from "../keymap";
import { Keys } from "@runbun/ui/solid/Tip";
import { AppContext } from "./context";

/** A command the palette offers: its name, the keys that run it too, and what it does. `when` false leaves it out. */
export type PaletteCommand = { id: string; label: string; keys?: string[]; run: () => void; when?: () => boolean };

type Mode = "files" | "commands";

// Open from anywhere (App.tsx's shortcuts, the commands themselves): one palette per page.
const [open, setOpen] = createSignal(false);
const [start, setStart] = createSignal("");

/** Opens the palette on the project's files (Mod+P) or, with ">" typed first, on the commands (Mod+Shift+P). */
export function openPalette(mode: Mode) {
  setStart(mode === "commands" ? ">" : "");
  setOpen(true);
}

/** At most this many rows: a filter narrows the rest. */
const LIMIT = 60;

/**
 * Where `query`'s characters appear in `text`, in order, or null when they don't all: the indices, preferring runs
 * and the starts of words and path parts. A lowercase query matches any case.
 */
function fuzzy(query: string, text: string): { score: number; at: number[] } | null {
  if (!query) return { score: 0, at: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const at: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const prev = at[at.length - 1];
    // A run, the start of a word or path part, and an early match count for more.
    score += prev !== undefined && i === prev + 1 ? 6 : 0;
    score += i === 0 || /[/\-_. ]/.test(text[i - 1]!) ? 4 : 0;
    score -= Math.min(i - from, 8) * 0.2;
    at.push(i);
    from = i + 1;
  }
  return { score, at };
}

/** `text` with the characters at `at` marked. */
function Marked(props: { text: string; at: number[] }) {
  const parts = () => {
    const out: { s: string; hit: boolean }[] = [];
    const hits = new Set(props.at);
    for (let i = 0; i < props.text.length; i++) {
      const hit = hits.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === hit) last.s += props.text[i];
      else out.push({ s: props.text[i]!, hit });
    }
    return out;
  };
  return <For each={parts()}>{(p) => (p.hit ? <mark>{p.s}</mark> : p.s)}</For>;
}

/**
 * Quick open and the command palette, one dialog: typing filters the project's files (Enter opens one); starting with
 * ">" filters the commands instead (Enter runs one), as in VS Code. Up and Down pick, Escape closes.
 */
export function Palette(props: { commands: PaletteCommand[] }) {
  return (
    <Kobalte open={open()} onOpenChange={setOpen}>
      <Kobalte.Portal>
        <Kobalte.Overlay class="dialog-overlay palette-overlay" />
        <div class="dialog-positioner">
          <Kobalte.Content class="dialog palette" aria-label="Go to a file or run a command">
            <PaletteBody commands={props.commands} close={() => setOpen(false)} />
          </Kobalte.Content>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  );
}

type Row = { key: string; label: string; detail?: string; at: number[]; keys?: string[]; run: () => void };

// Inside the content: each opening starts afresh, on what openPalette asked for.
function PaletteBody(props: { commands: PaletteCommand[]; close: () => void }) {
  const app = useContext(AppContext);
  const id = createUniqueId();
  const [query, setQuery] = createSignal(untrack(start));
  const [picked, setPicked] = createSignal(0);
  const mode = (): Mode => (query().startsWith(">") ? "commands" : "files");
  // The project's files, as the tree shows them: not node_modules or .git, nor what the tree leaves out.
  const files = untrack(() =>
    [...app.vfs.files.keys()].filter((p) => !/(^|\/)(node_modules|\.git)\//.test(p) && !app.workspace.isGenerated(p) && !app.workspace.isHiddenConfig(p)).sort(),
  );
  const rows = createMemo<Row[]>(() => {
    if (mode() === "commands") {
      const q = query().slice(1).trim();
      return props.commands
        .filter((c) => c.when?.() ?? true)
        .flatMap((c) => {
          const m = fuzzy(q, c.label);
          return m ? [{ key: c.id, label: c.label, at: m.at, keys: c.keys, run: c.run, score: m.score }] : [];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, LIMIT);
    }
    const q = query().trim();
    return files
      .flatMap((path) => {
        const slash = path.lastIndexOf("/");
        const name = path.slice(slash + 1);
        // The file's name first; else the whole path.
        const byName = fuzzy(q, name);
        const m = byName ? { score: byName.score + 10, at: byName.at.map((i) => i + slash + 1) } : fuzzy(q, path);
        return m ? [{ path, name, slash, ...m }] : [];
      })
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, LIMIT)
      .map((f) => ({
        key: f.path,
        label: f.name,
        detail: f.slash > 0 ? f.path.slice(0, f.slash) : undefined,
        at: f.at.filter((i) => i > f.slash).map((i) => i - f.slash - 1),
        run: () => app.workspace.open(f.path),
      }));
  });
  const choose = (row: Row | undefined) => {
    if (!row) return;
    props.close();
    // After the dialog has let go of the focus, so a command that moves it (or opens a dialog) keeps it.
    requestAnimationFrame(() => row.run());
  };
  let list!: HTMLUListElement;
  const move = (to: number) => {
    const n = rows().length;
    if (!n) return;
    const i = (to + n) % n;
    setPicked(i);
    list.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };
  return (
    <>
      <input
        class="palette-input"
        type="text"
        spellcheck={false}
        autocomplete="off"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={rows().length ? `${id}-${picked()}` : undefined}
        aria-label={mode() === "commands" ? "Run a command" : "Go to a file (type > for commands)"}
        placeholder={mode() === "commands" ? "Run a command" : "Go to a file (type > for commands)"}
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setPicked(0);
          list.scrollTop = 0;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") move(picked() + 1);
          else if (e.key === "ArrowUp") move(picked() - 1);
          else if (e.key === "Enter") choose(rows()[picked()]);
          else return;
          e.preventDefault();
        }}
      />
      <ul class="palette-list" id={`${id}-list`} role="listbox" ref={list} aria-label={mode() === "commands" ? "Commands" : "Files"}>
        <For each={rows()}>
          {(row, i) => (
            <li
              id={`${id}-${i()}`}
              role="option"
              data-index={i()}
              aria-selected={i() === picked() ? "true" : "false"}
              onPointerMove={() => setPicked(i())}
              onClick={() => choose(row)}
            >
              <Show when={mode() === "files"} fallback={<i class="i-lucide-chevron-right" aria-hidden="true" />}>
                <i class="i-lucide-file" aria-hidden="true" />
              </Show>
              <span class="label">
                <Marked text={row.label} at={row.at} />
              </span>
              <Show when={row.detail}>
                <span class="detail">{row.detail}</span>
              </Show>
              <Show when={row.keys?.length}>
                <span class="keys">
                  <Keys keys={row.keys!.map(chordKeys)} />
                </span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={!rows().length}>
        <p class="palette-empty">{mode() === "commands" ? "No command matches." : "No file matches."}</p>
      </Show>
    </>
  );
}
