import { createEffect, onSettled, useContext } from "solid-js";
import { mountDiagnostics } from "../diagnostics";
import { createPierre } from "../editors/pierre";
import type { CodeEditor } from "../editors/types";
import { AppContext } from "./context";
import { guarded } from "./guarded";
import { EditorTabs } from "./Tabs";

/** The open-file tabs over the editor, which shows the active tab and writes edits back to the VFS. */
export function EditorPane() {
  const { vfs, workspace: ws, session } = useContext(AppContext);
  let el!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  let check: ReturnType<typeof mountDiagnostics> | undefined;
  // The file the editor shows, as last applied; edits to any other file are stale.
  let current: string | null = null;

  createEffect(
    () => ws.state.active,
    guarded("editor", (path) => {
      editor ??= createPierre(el);
      check ??= mountDiagnostics(vfs, editor);
      current = path;
      if (!path) {
        editor.clear();
        check(null, null);
        return;
      }
      const data = vfs.read(path);
      const text = typeof data === "string" ? data : null;
      editor.open(path, text, (next) => {
        if (current !== path) return;
        vfs.write(path, next);
        check!(path, next);
      });
      check(path, text);
    }),
  );

  onSettled(() => {
    // The open file changed outside the editor (e.g. `Bun.write`).
    const unsubscribe = vfs.onChange(({ path, created, removed }) => {
      if (created || removed || path !== current) return;
      const d = vfs.read(path);
      if (typeof d === "string") {
        editor?.update(d);
        check?.(path, d);
      }
    });
    return () => {
      unsubscribe();
      editor?.destroy();
    };
  });

  return (
    <>
      <EditorTabs placeholder={!session.ready() && !ws.state.open.length} />
      {/* "No file open" only once the project has loaded, not while its first file is on the way. */}
      <div id="editor" ref={el} data-empty={session.ready() && !ws.state.active ? "" : undefined} />
    </>
  );
}
