import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import type { CodeEditor } from "./types";

export function createCodeMirror(parent: HTMLElement): CodeEditor {
  const view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
  return {
    open(_path, text, onChange) {
      view.setState(
        EditorState.create({
          doc: text ?? "(binary file)",
          extensions: [
            basicSetup,
            javascript({ typescript: true, jsx: true }),
            oneDark,
            EditorState.readOnly.of(text === null),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) onChange(u.state.doc.toString());
            }),
          ],
        }),
      );
    },
    update(text) {
      if (text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    getText: () => view.state.doc.toString(),
    destroy: () => view.destroy(),
  };
}
