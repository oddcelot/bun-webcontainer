import { Show, createSignal, useContext } from "solid-js";
import { catalog, type CatalogEntry } from "../examples";
import { AppContext } from "./context";
import { Gallery } from "./Gallery";
import { PromptDialog } from "./PromptDialog";
import { Dialog } from "@runbun/ui/solid/Dialog";
import { Tip } from "@runbun/ui/solid/Tip";

/**
 * The project switcher: a button naming the open project, which opens the gallery of starters, examples and GitHub
 * repos, with entries to open a local folder, a zip or any GitHub repo.
 */
export function ProjectPicker() {
  const app = useContext(AppContext);
  const s = app.session;
  const [open, setOpen] = createSignal(false);
  const [askingRepo, setAskingRepo] = createSignal(false);
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
            onRepo: () => then(() => setAskingRepo(true)),
            onReopen: () => then(() => app.reopenFolder()),
          }}
        />
      </Dialog>
      <PromptDialog
        open={askingRepo()}
        onOpenChange={setAskingRepo}
        title="Open a GitHub repo"
        description="owner/repo, owner/repo@ref or a github.com URL"
        label="Repository"
        initial={app.repoParam || "oddcelot/bun-elysia-demo"}
        submit="Open"
        onSubmit={(input) => app.openProject(`repo:${input}`)}
        returnFocus={() => trigger}
      />
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
