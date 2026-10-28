import { File } from "@pierre/diffs";
import { Editor, type Marker } from "@pierre/diffs/edit";
import { onTheme, themeName } from "../theme";
import type { CodeEditor } from "./types";

/** @pierre/diffs edit mode: a highlighted `File` surface with an `Editor` attached. */
export function createPierre(parent: HTMLElement): CodeEditor {
  const host = document.createElement("div");
  host.className = "pierre-host";
  parent.replaceChildren(host);

  let view: File | undefined;
  let finish: (() => void) | undefined;
  let editor: Editor<"file"> | undefined;
  let text = "";
  let path = "";
  let listener: (text: string) => void = () => {};
  let theme = themeName();
  let markers: Marker[] = [];

  onTheme((next) => {
    if (next === theme) return;
    theme = next;
    if (!view) return;
    view.setOptions({ ...view.options, theme });
    view.onThemeChange();
  });

  function close() {
    finish?.();
    finish = undefined;
    editor = undefined;
    view?.cleanUp();
    view = undefined;
  }

  /** Whether the current editor shows markers (a fresh one shows none). */
  let shown = false;
  /**
   * The editor sets up its text document a few frames after `edit()` and throws on markers before that, so
   * markers wait for it. Clearing markers that aren't shown is skipped.
   */
  function applyMarkers(frames = 30) {
    const current = editor;
    if (!current || (!markers.length && !shown)) return;
    try {
      current.setMarkers(markers);
      shown = markers.length > 0;
    } catch (e) {
      if (!frames) return console.warn("[editor] markers dropped:", e);
      requestAnimationFrame(() => editor === current && applyMarkers(frames - 1));
    }
  }

  function show(nextPath: string, nextText: string | null) {
    close();
    if (nextPath !== path) markers = [];
    path = nextPath;
    text = nextText ?? "";
    view = new File({
      theme,
      onEditChange(event) {
        text = event.file.contents;
        listener(text);
      },
      // The VFS already holds every change from onEditChange; keep the surface showing it.
      onEditComplete: () => "accept",
    });
    view.render({ containerWrapper: host, file: { name: path, contents: nextText ?? "(binary file)" } });
    if (nextText === null) return;
    editor = new Editor("file");
    shown = false;
    finish = editor.edit(view);
    if (markers.length) applyMarkers();
  }

  return {
    open(nextPath, nextText, onChange) {
      listener = onChange;
      show(nextPath, nextText);
    },
    update(nextText) {
      if (nextText !== text) show(path, nextText);
    },
    setDiagnostics(diagnostics) {
      markers = diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        source: "bun",
        start: { line: d.line - 1, character: d.column - 1 },
        end: { line: d.line - 1, character: d.column - 1 + Math.max(d.length, 1) },
      }));
      applyMarkers();
    },
    getText: () => editor?.getText() ?? text,
    clear() {
      close();
      host.replaceChildren();
      path = text = "";
      markers = [];
      listener = () => {};
    },
    destroy() {
      close();
      host.remove();
    },
  };
}
