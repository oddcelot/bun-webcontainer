import { CodeView, parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import { Show, createSignal, onSettled, useContext } from "solid-js";
import { trackChanges, type Change } from "../changes";
import { onTheme, themeName } from "../theme";
import { AppContext } from "./context";

/** One CodeView item per changed file; `version` goes up when its contents change, so CodeView re-renders only it. */
function toItem(c: Change, version: number): CodeViewItem<undefined> {
  if (c.before === null || c.after === null)
    return { id: c.path, type: "file", version, file: { name: c.path, contents: `Binary file ${c.kind}; its contents aren't shown.` } };
  const before = c.kind === "added" ? null : { name: c.path, contents: c.before };
  const after = c.kind === "deleted" ? null : { name: c.path, contents: c.after };
  return { id: c.path, type: "diff", version, fileDiff: parseDiffFromFile(before, after) };
}

/**
 * The Changes tab: every file that differs from the project's source (the demo, the example, the shared link, the
 * repo, the folder as opened), as diffs in one scrolling CodeView that follows edits as they're saved.
 */
export function ChangesView(props: { shown: boolean }) {
  const { vfs, workspace: ws } = useContext(AppContext);
  let el!: HTMLDivElement;
  const [list, setList] = createSignal<Change[] | null>(null);
  const [missing, setMissing] = createSignal(false);

  onSettled(() => {
    let theme = themeName();
    const options = () => ({
      theme,
      stickyHeaders: true,
      diffStyle: "unified" as const,
      unsafeCSS: "* { scrollbar-width: thin; }",
      // An "Open" button in each header (not for a deleted file), to edit the file in its tab.
      renderHeaderMetadata: (fileDiff: { name: string; type?: string }) => {
        if (fileDiff.type === "deleted") return null;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "changes-open";
        b.textContent = "Open";
        b.title = `Open ${fileDiff.name}`;
        b.onclick = () => ws.open(fileDiff.name);
        return b;
      },
    });
    const view = new CodeView<undefined>(options());
    view.setup(el);
    // Last contents per path, to keep an unchanged file's version (and its rendering).
    const seen = new Map<string, { before: string | null; after: string | null; version: number }>();
    const stop = trackChanges(vfs, (next, gone) => {
      setList(next);
      setMissing(gone);
      if (!next) return;
      const items = next.map((c) => {
        const was = seen.get(c.path);
        const version = was && was.before === c.before && was.after === c.after ? was.version : (was?.version ?? -1) + 1;
        seen.set(c.path, { before: c.before, after: c.after, version });
        return toItem(c, version);
      });
      for (const path of [...seen.keys()]) if (!next.some((c) => c.path === path)) seen.delete(path);
      view.setItems(items);
    });
    const offTheme = onTheme((next) => {
      if (next === theme) return;
      theme = next;
      view.setOptions(options());
    });
    return () => {
      stop();
      offTheme();
      view.cleanUp();
    };
  });

  const count = () => list()?.length ?? 0;
  return (
    <div class="changes" hidden={!props.shown}>
      <div class="changes-head" aria-live="polite">
        <Show when={list()} fallback={<span>{missing() ? "The project's source couldn't be loaded to compare against." : "Loading the project's source…"}</span>}>
          {(l) => (
            <span>
              {count() ? `${count()} ${count() === 1 ? "file differs" : "files differ"} from the project's source` : "No changes: the files are as the project's source has them."}
              <Show when={l().length}>
                <span class="changes-kinds">
                  <Kinds list={l()} />
                </span>
              </Show>
            </span>
          )}
        </Show>
      </div>
      <div class="changes-list" ref={el} />
    </div>
  );
}

function Kinds(props: { list: Change[] }) {
  const n = (kind: Change["kind"]) => props.list.filter((c) => c.kind === kind).length;
  return (
    <>
      <Show when={n("modified")}>
        <span>{n("modified")} modified</span>
      </Show>
      <Show when={n("added")}>
        <span>{n("added")} added</span>
      </Show>
      <Show when={n("deleted")}>
        <span>{n("deleted")} deleted</span>
      </Show>
    </>
  );
}
