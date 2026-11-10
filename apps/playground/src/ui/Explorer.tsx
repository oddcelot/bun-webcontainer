import { Show, createEffect, useContext } from "solid-js";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { AppContext, type App } from "./context";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";

/**
 * Shows or hides Git (the `toggleGit` shortcut, the status bar's Git button): shows the Git view, or hides the pane
 * when Git is what it shows. `toggleTree` shows or hides the pane; without one (the embed's can't be toggled from
 * here) a shown Git goes back to the files instead. False: nothing was done (git is off, or the pane isn't there), so
 * the key goes on.
 */
export function toggleGit(app: App, treeShown: boolean, toggleTree?: () => void): boolean {
  if (!(app.features?.has("git") ?? true)) return false;
  const showsGit = treeShown && app.git.state.view === "git";
  if (!treeShown) {
    if (!toggleTree) return false;
    app.git.setView("git");
    toggleTree();
  } else if (!showsGit) app.git.setView("git");
  else if (toggleTree) toggleTree();
  else app.git.setView("files");
  return true;
}

/**
 * The status bar's Files button: shows the files (bringing the pane back if hidden), or hides the pane when the files
 * are what it shows.
 */
export function toggleFiles(app: App, treeShown: boolean, toggleTree: () => void) {
  if (treeShown && app.git.state.view === "git") app.git.setView("files");
  else {
    if (!treeShown) app.git.setView("files");
    toggleTree();
  }
}

/**
 * The explorer pane: the file tree, or with Git on a Git view in its place (VS Code's Source Control). The playground
 * picks it with the status bar's Files and Git buttons; the embed, which has no status bar, with a Files | Git switch
 * above (`switcher`). The tree stays mounted while Git shows (its selection and folders stay), the Git panel is built
 * when it is first shown.
 */
export function Explorer(props: { switcher?: boolean }) {
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
      <Show when={props.switcher && on()}>
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
