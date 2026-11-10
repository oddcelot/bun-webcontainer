import { Show, createEffect, useContext } from "solid-js";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { AppContext, type App } from "./context";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";

/**
 * Shows or hides Git (the `toggleGit` shortcut): shows the Git view, or goes back to the files when it is the one
 * shown. `showTree` brings the pane back when it was hidden (an embed's can't be). False: nothing was done (git is
 * off, or the pane isn't there), so the key goes on.
 */
export function toggleGit(app: App, treeShown: boolean, showTree?: () => void): boolean {
  if (!(app.features?.has("git") ?? true)) return false;
  if (!treeShown) {
    if (!showTree) return false;
    showTree();
    app.git.setView("git");
  } else app.git.setView(app.git.state.view === "git" ? "files" : "git");
  return true;
}

/**
 * The explorer pane: the file tree, or with Git on a Git view in its place (VS Code's Source Control), picked by a
 * Files | Git switch above. The tree stays mounted while Git shows (its selection and folders stay), the Git panel
 * is built when it is first shown.
 */
export function Explorer() {
  const app = useContext(AppContext);
  const git = app.git;
  const on = () => app.features?.has("git") ?? true;
  const view = () => (on() ? git.state.view : "files");
  // A project opened in place (another example, a folder): the repository it has.
  createEffect(
    () => app.workspace.state.treeVersion,
    () => {
      git.projectChanged();
    },
    { defer: true },
  );
  return (
    <div class="explorer">
      <Show when={on()}>
        <div class="explorer-switch">
          <Segmented
            label="Explorer view"
            value={view()}
            options={[
              ["files", "Files", "i-lucide-files", "Files"],
              ["git", "Git", "i-lucide-git-branch", "Source control: changes, commits and branches"],
            ]}
            onChange={(v) => git.setView(v === "git" ? "git" : "files")}
          />
        </div>
      </Show>
      <div class="explorer-body">
        <div class="explorer-pane" hidden={view() !== "files"}>
          <FileTree />
        </div>
        <Show when={view() === "git"}>
          <GitPanel />
        </Show>
      </div>
    </div>
  );
}
