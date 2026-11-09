import { For, Show, createMemo, createSignal, useContext } from "solid-js";
import { catalog, techIcons, type CatalogEntry, type ProjectKind } from "../examples";
import { AppContext } from "./context";
import { PromptDialog } from "./PromptDialog";
import { Button } from "@runbun/ui/solid/Button";
import { Chip, Chips } from "@runbun/ui/solid/Chips";
import { Dialog, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Input } from "@runbun/ui/solid/Input";
import { Tip } from "@runbun/ui/solid/Tip";

type Tab = "all" | ProjectKind;
const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: "all", label: "All", icon: "i-lucide-layout-grid" },
  { value: "starter", label: "Starters", icon: "i-lucide-sparkles" },
  { value: "example", label: "Examples", icon: "i-lucide-flask-conical" },
  { value: "github", label: "From GitHub", icon: "i-lucide-github" },
];

/** Whether an entry matches every word of the search (in its name, description, tags or section) and every picked tag. */
function matches(e: CatalogEntry, words: string[], tags: string[]) {
  const text = `${e.name} ${e.description} ${e.tags.join(" ")} ${TABS.find((t) => t.value === e.kind)!.label}`.toLowerCase();
  return words.every((w) => text.includes(w)) && tags.every((t) => e.tags.includes(t));
}

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

  const pick = (e: CatalogEntry) => {
    setOpen(false);
    if (e.value !== s.project().selected || s.project().extra.length) app.openProject(e.value);
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
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          trigger.focus();
        }}
      >
        <Gallery
          selected={s.project().extra.length ? null : s.project().selected}
          reopen={reopen()}
          onPick={pick}
          onClose={() => setOpen(false)}
          onFolder={() => then(() => ("showDirectoryPicker" in window ? app.openDirectory() : folderInput.click()))}
          onZip={() => then(() => zipInput.click())}
          onRepo={() => then(() => setAskingRepo(true))}
          onReopen={() => then(() => app.reopenFolder())}
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

// Inside the dialog's content, so the search, tab and tags start afresh on each opening.
function Gallery(props: {
  /** The open catalog entry's value; null when the page holds something else (a repo, a share link, a folder). */
  selected: string | null;
  reopen?: string;
  onPick: (e: CatalogEntry) => void;
  onClose: () => void;
  onFolder: () => void;
  onZip: () => void;
  onRepo: () => void;
  onReopen: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("all");
  const [query, setQuery] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);

  const words = createMemo(() => query().toLowerCase().split(/\s+/).filter(Boolean));
  const found = createMemo(() => catalog.filter((e) => matches(e, words(), tags())));
  const shown = createMemo(() => found().filter((e) => tab() === "all" || e.kind === tab()));
  const count = (t: Tab) => found().filter((e) => t === "all" || e.kind === t).length;
  // Every tag in the open section, so the chips only offer ones that can narrow it.
  const allTags = createMemo(() => [...new Set(catalog.filter((e) => tab() === "all" || e.kind === tab()).flatMap((e) => e.tags))].sort());

  return (
    <>
      <div class="gallery-head">
        <DialogTitle>Open a project</DialogTitle>
        <label class="gallery-search">
          <i class="i-lucide-search" aria-hidden="true" />
          <Input
            type="search"
            placeholder="Search by name or technology"
            aria-label="Search projects"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <Tip class="gallery-close" type="button" tip="Close" aria-label="Close" onClick={() => props.onClose()}>
          <i class="i-lucide-x" aria-hidden="true" />
        </Tip>
      </div>
      <div class="gallery-body">
        <nav class="gallery-nav">
          <div
            role="tablist"
            aria-label="Sections"
            aria-orientation="vertical"
            onKeyDown={(e) => {
              const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
              const i = all.indexOf(document.activeElement as HTMLElement);
              const next = { ArrowUp: all[i - 1], ArrowDown: all[i + 1], Home: all[0], End: all[all.length - 1] }[e.key];
              if (i < 0 || !next) return;
              e.preventDefault();
              next.focus();
              setTab(next.dataset.value as Tab);
            }}
          >
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  id={`gallery-tab-${t.value}`}
                  data-value={t.value}
                  aria-selected={tab() === t.value ? "true" : "false"}
                  aria-controls="gallery-list"
                  tabindex={tab() === t.value ? 0 : -1}
                  onClick={() => setTab(t.value)}
                >
                  <i class={t.icon} aria-hidden="true" />
                  <span class="label">{t.label}</span>
                  <span class="count">{count(t.value)}</span>
                </button>
              )}
            </For>
          </div>
          <div class="gallery-open">
            <span class="heading">Open</span>
            <Show when={props.reopen}>
              {(name) => (
                <button type="button" onClick={() => props.onReopen()}>
                  <i class="i-lucide-folder-sync" aria-hidden="true" /> Reopen {name()}
                </button>
              )}
            </Show>
            <button type="button" onClick={() => props.onFolder()}>
              <i class="i-lucide-folder-open" aria-hidden="true" /> Folder…
            </button>
            <button type="button" onClick={() => props.onZip()}>
              <i class="i-lucide-file-archive" aria-hidden="true" /> Zip file…
            </button>
            <button type="button" onClick={() => props.onRepo()}>
              <i class="i-lucide-github" aria-hidden="true" /> GitHub repo…
            </button>
          </div>
        </nav>
        <div class="gallery-main" id="gallery-list" role="tabpanel" aria-labelledby={`gallery-tab-${tab()}`}>
          <Chips label="Filter by technology" value={tags()} onChange={setTags}>
            <For each={allTags()}>
              {(t) => (
                <Chip value={t}>
                  <TechIcon tag={t} /> {t}
                </Chip>
              )}
            </For>
          </Chips>
          <Show
            when={shown().length}
            fallback={
              <div class="gallery-empty">
                <p>No project matches.</p>
                <Button
                  onClick={() => {
                    setQuery("");
                    setTags([]);
                  }}
                >
                  Clear the filters
                </Button>
              </div>
            }
          >
            <ul class="gallery-grid">
              <For each={shown()}>
                {(e) => (
                  <li>
                    <button
                      type="button"
                      class="gallery-card"
                      data-current={props.selected === e.value ? "" : undefined}
                      aria-current={props.selected === e.value ? "true" : undefined}
                      onClick={() => props.onPick(e)}
                    >
                      <i class={["icon", e.icon]} aria-hidden="true" />
                      <span class="text">
                        <span class="name">
                          {e.name}
                          <Show when={props.selected === e.value}>
                            <span class="badge">open</span>
                          </Show>
                        </span>
                        <span class="description">{e.description}</span>
                        <span class="tags">
                          <For each={e.tags}>
                            {(t) => (
                              <span class={["tag", { on: tags().includes(t) }]}>
                                <TechIcon tag={t} /> {t}
                              </span>
                            )}
                          </For>
                        </span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </>
  );
}

/** A technology's logo, before its name in a tag. */
function TechIcon(props: { tag: string }) {
  return (
    <Show when={techIcons[props.tag]}>
      {(icon) => <i class={["tech", icon()]} aria-hidden="true" />}
    </Show>
  );
}
