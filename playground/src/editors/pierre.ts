import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
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

  function show(nextPath: string, nextText: string | null) {
    close();
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
    finish = editor.edit(view);
  }

  return {
    open(nextPath, nextText, onChange) {
      listener = onChange;
      show(nextPath, nextText);
    },
    update(nextText) {
      if (nextText !== text) show(path, nextText);
    },
    getText: () => editor?.getText() ?? text,
    clear() {
      close();
      host.replaceChildren();
      path = text = "";
      listener = () => {};
    },
    destroy() {
      close();
      host.remove();
    },
  };
}
