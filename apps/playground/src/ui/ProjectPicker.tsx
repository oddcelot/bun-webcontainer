import { Show, createSignal, useContext } from "solid-js";
import { catalog, type CatalogEntry } from "../examples";
import { AppContext } from "./context";
import { Gallery } from "./Gallery";
import { PromptDialog } from "./PromptDialog";
import { Dialog } from "@runbun/ui/solid/Dialog";
import { Tip } from "@runbun/ui/solid/Tip";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { gitUrl } from "../git/remoteUrl";
import { RepoList } from "./RepoList";

/** How "Open a repository" opens one: its files (GitHub's API), or a clone with its history (git, through the proxy). */
type RepoMode = "files" | "git";
const [askingRepo, setAskingRepo] = createSignal<RepoMode | null>(null);

/** Opens "Open a repository", set to `mode` (the Git panel's "Clone a repository" asks for a clone). */
export const askRepo = (mode: RepoMode) => setAskingRepo(mode);

/**
 * The project switcher: a button naming the open project, which opens the gallery of starters, examples and GitHub
 * repos, with entries to open a local folder, a zip or any GitHub repo.
 */
export function ProjectPicker() {
  const app = useContext(AppContext);
  const s = app.session;
  const [open, setOpen] = createSignal(false);
  const gitOn = () => app.features?.has("git") ?? true;
  // The mode the dialog was opened with, kept while it closes (the title doesn't flip during the fade).
  let last: RepoMode = "files";
  const mode = () => (last = askingRepo() ?? last);
  let trigger!: HTMLButtonElement;
  let folderInput!: HTMLInputElement;
  let zipInput!: HTMLInputElement;

  /** The open project's name: a catalog entry's, else this page's own (a repo, a share link, a folder). */
  const current = () => {
    const p = s.project();
    return catalog.find((e) => e.value === p.selected) ?? (p.extra.find(([, v]) => v === p.selected) ?? p.extra[0])?.[0] ?? "Confetti demo";
  };
  const reopen = () => (s.project().selected === "#folder" ? undefined : s.project().reopen);

  // A pick opens another project, whose editor takes focus (main.ts): the button doesn't, or its tooltip would show.
  let picked = false;
  const pick = (e: CatalogEntry) => {
    picked = e.value !== s.project().selected || s.project().extra.length > 0;
    setOpen(false);
    if (picked) app.openProject(e.value);
  };
  // After the gallery closes, or its focus return would win over the next dialog or the file picker.
  const then = (fn: () => void) => {
    setOpen(false);
    setTimeout(fn);
  };

  return (
    <>
      <Tip id="example" ref={(el: HTMLButtonElement) => (trigger = el)} type="button" tip="Open a project: starters, examples, GitHub, your files" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Show when={current()} keyed>
          {(c) =>
            typeof c === "string" ? (
              <>
                <i class="i-lucide-folder-code" aria-hidden="true" />
                <span class="name">{c}</span>
              </>
            ) : (
              <>
                <i class={c.icon} aria-hidden="true" />
                <span class="name">{c.name}</span>
              </>
            )
          }
        </Show>
        <i class="i-lucide-chevrons-up-down chevron" aria-hidden="true" />
      </Tip>
      {/* Controlled, so Kobalte has no trigger of its own to hand focus back to. */}
      <Dialog
        open={open()}
        onOpenChange={setOpen}
        class="gallery"
        onOpenAutoFocus={() => (picked = false)}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!picked) trigger.focus();
        }}
      >
        <Gallery
          catalog={catalog}
          selected={s.project().extra.length ? null : s.project().selected}
          onPick={pick}
          onClose={() => setOpen(false)}
          opens={{
            reopen: reopen(),
            onFolder: () => then(() => ("showDirectoryPicker" in window ? app.openDirectory() : folderInput.click())),
            onZip: () => then(() => zipInput.click()),
            onRepo: () => then(() => setAskingRepo("files")),
            onReopen: () => then(() => app.reopenFolder()),
          }}
        />
      </Dialog>
      <PromptDialog
        open={askingRepo() !== null}
        onOpenChange={(o) => {
          if (o) return;
          setAskingRepo(null);
        }}
        title={mode() === "git" ? "Clone a repository" : "Open a repository"}
        description={
          mode() === "git"
            ? "owner/repo, or an https:// URL on GitHub, GitLab, Codeberg or Bitbucket. Brings the last 50 commits: commit, branch, fetch and pull in the Git view."
            : "owner/repo, owner/repo@ref or a github.com URL. Opens its files from GitHub, without their history."
        }
        label="Repository"
        initial={app.repoParam || "oddcelot/bun-elysia-demo"}
        submit={mode() === "git" ? "Clone" : "Open"}
        check={(input) => {
          if (mode() !== "git") return;
          const r = gitUrl(input);
          return "error" in r ? `Can't clone that: ${r.error}.` : undefined;
        }}
        onSubmit={(input) => {
          if (mode() === "git") {
            const r = gitUrl(input);
            if ("url" in r) app.openProject(`git:${r.url}`);
          } else app.openProject(`repo:${input}`);
        }}
        returnFocus={() => trigger}
      >
        <Show when={gitOn()}>
          <div class="dialog-choice">
            <Segmented
              label="How to open it"
              value={mode()}
              options={[
                ["files", "Files", "i-lucide-files", "Its files from GitHub, without their history: quick"],
                ["git", "With Git history", "i-lucide-git-branch", "A clone with its last commits: commit, branch, fetch and pull"],
              ]}
              onChange={(v) => setAskingRepo(v === "git" ? "git" : "files")}
            />
          </div>
          {/* Sign-in is the playground's (runbun.dev's cookies); an embed has no gallery. */}
          <Show when={mode() === "git" && !app.features}>
            <RepoList
              onPick={(name) => {
                setAskingRepo(null);
                picked = true;
                app.openProject(`git:https://github.com/${name}`);
              }}
            />
          </Show>
        </Show>
      </PromptDialog>
      <input
        ref={folderInput}
        id="folderinput"
        type="file"
        webkitdirectory
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) app.openFolder(files);
        }}
      />
      <input
        ref={zipInput}
        id="zipinput"
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) app.openZip(file);
        }}
      />
    </>
  );
}
