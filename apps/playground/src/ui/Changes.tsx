import { CodeView, parseDiffFromFile, type CodeViewItem } from "@pierre/diffs";
import { Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { trackChanges, type Change } from "../changes";
import { onTheme, themeName } from "../theme";
import { AppContext } from "./context";

/** One CodeView item per changed file; `version` goes up when its contents change, so CodeView re-renders only it. */
function toItem(c: Change, version: number): CodeViewItem<undefined> {
  if (c.before === null || c.after === null)
    return { id: c.path, type: "file", version, file: { name: c.path, contents: `Binary file ${c.kind}. No preview.` } };
  const before = c.kind === "added" ? null : { name: c.path, contents: c.before };
  const after = c.kind === "deleted" ? null : { name: c.path, contents: c.after };
  return { id: c.path, type: "diff", version, fileDiff: parseDiffFromFile(before, after) };
}

/**
 * The Changes tab: every file that differs from the project's source (the demo, the example, the shared link, the
 * repo, the folder as opened), as diffs in one scrolling CodeView that follows edits as they're saved.
 */
export function ChangesView(props: { shown: boolean }) {
  const { vfs, workspace: ws, git } = useContext(AppContext);
  let el!: HTMLDivElement;
  let view: CodeView<undefined> | undefined;
  /** What the tab compares with: the repository's last commit once it has one, else where the project came from. */
  const against = () => (git.state.hasHead ? "the last commit" : "the project's source");
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
    const codeView = new CodeView<undefined>(options());
    view = codeView;
    codeView.setup(el);
    // Last contents per path, to keep an unchanged file's version (and its rendering).
    const seen = new Map<string, { before: string | null; after: string | null; version: number }>();
    const stop = trackChanges(vfs, (next, gone) => {
      setList(next);
      setMissing(gone);
      latest = next ?? latest;
      if (!next) return;
      const items = next.map((c) => {
        const was = seen.get(c.path);
        const version = was && was.before === c.before && was.after === c.after ? was.version : (was?.version ?? -1) + 1;
        seen.set(c.path, { before: c.before, after: c.after, version });
        return toItem(c, version);
      });
      for (const path of [...seen.keys()]) if (!next.some((c) => c.path === path)) seen.delete(path);
      codeView.setItems(items);
      scrollToPending();
    });
    const offTheme = onTheme((next) => {
      if (next === theme) return;
      theme = next;
      codeView.setOptions(options());
    });
    return () => {
      stop();
      offTheme();
      codeView.cleanUp();
      view = undefined;
    };
  });
  // The Git view's click on a file: its diff at the top (a folder of untracked files: the first one in it). Asked before
  // the list is in, it scrolls once it is.
  let latest: Change[] | null = null;
  let pending = "";
  const scrollToPending = () => {
    if (!pending || !latest || !view) return;
    const hit = latest.find((c) => c.path === pending) ?? latest.find((c) => pending.endsWith("/") && c.path.startsWith(pending));
    pending = "";
    if (hit) view.scrollTo({ type: "item", id: hit.path, align: "start" });
  };
  createEffect(
    () => ws.state.changesFocus,
    ({ path }) => {
      pending = path;
      scrollToPending();
    },
  );
  const count = () => list()?.length ?? 0;
  return (
    <div class="changes" hidden={!props.shown}>
      <div class="changes-head" aria-live="polite">
        <Show when={list()} fallback={<span>{missing() ? `Couldn't load ${against()} to compare.` : `Loading ${against()}…`}</span>}>
          {(l) => (
            <span>
              {count() ? `${count()} ${count() === 1 ? "file differs" : "files differ"} from ${against()}` : git.state.hasHead ? "No changes since the last commit." : "No changes from the project's source."}
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
