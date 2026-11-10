import { For, Show, createMemo, createSignal } from "solid-js";
import { techIcons, type CatalogEntry, type ProjectKind } from "../examples";
import { Button } from "@runbun/ui/solid/Button";
import { Chip, Chips } from "@runbun/ui/solid/Chips";
import { DialogTitle } from "@runbun/ui/solid/Dialog";
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

/** The playground's Open section: a local folder (or the last one again), a zip, a repository (its files, or a clone). */
export type GalleryOpens = { reopen?: string; onFolder: () => void; onZip: () => void; onRepo: () => void; onReopen: () => void };

/**
 * The project gallery, inside a Dialog with class "gallery" (so the search, tab and tags start afresh on each opening):
 * a search, technology tags and cards, in sections when the projects are of more than one kind. The playground's
 * (ProjectPicker.tsx) lists its catalog and the Open section; an embed's (EmbedApp.tsx) only its library.
 */
export function Gallery(props: {
  catalog: CatalogEntry[];
  /** The open entry's value; null when the page holds something else (a repo, a share link, a folder). */
  selected: string | null;
  onPick: (e: CatalogEntry) => void;
  onClose: () => void;
  opens?: GalleryOpens;
}) {
  const [tab, setTab] = createSignal<Tab>("all");
  const [query, setQuery] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);

  const words = createMemo(() => query().toLowerCase().split(/\s+/).filter(Boolean));
  const found = createMemo(() => props.catalog.filter((e) => matches(e, words(), tags())));
  const shown = createMemo(() => found().filter((e) => tab() === "all" || e.kind === tab()));
  const count = (t: Tab) => found().filter((e) => t === "all" || e.kind === t).length;
  // Every tag in the open section, so the chips only offer ones that can narrow it.
  const allTags = createMemo(() => [...new Set(props.catalog.filter((e) => tab() === "all" || e.kind === tab()).flatMap((e) => e.tags))].sort());

  // All, and a section per kind there is, when there's more than one.
  const tabs = createMemo(() => {
    const kinds = TABS.filter((t) => t.value !== "all" && props.catalog.some((e) => e.kind === t.value));
    return kinds.length > 1 ? [TABS[0], ...kinds] : [];
  });

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
      <div class="gallery-body" data-nav={tabs().length || props.opens ? "" : undefined}>
        <Show when={tabs().length || props.opens}>
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
              <For each={tabs()}>
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
            <Show when={props.opens}>
              {(o) => (
                <div class="gallery-open">
                  <span class="heading">Open</span>
                  <Show when={o().reopen}>
                    {(name) => (
                      <button type="button" onClick={() => o().onReopen()}>
                        <i class="i-lucide-folder-sync" aria-hidden="true" /> Reopen {name()}
                      </button>
                    )}
                  </Show>
                  <button type="button" onClick={() => o().onFolder()}>
                    <i class="i-lucide-folder-open" aria-hidden="true" /> Folder…
                  </button>
                  <button type="button" onClick={() => o().onZip()}>
                    <i class="i-lucide-file-archive" aria-hidden="true" /> Zip file…
                  </button>
                  <button type="button" onClick={() => o().onRepo()}>
                    <i class="i-lucide-github" aria-hidden="true" /> Repository…
                  </button>
                </div>
              )}
            </Show>
          </nav>
        </Show>
        <div class="gallery-main" id="gallery-list" role={tabs().length ? "tabpanel" : undefined} aria-labelledby={tabs().length ? `gallery-tab-${tab()}` : undefined}>
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
export function TechIcon(props: { tag: string }) {
  return (
    <Show when={techIcons[props.tag]}>
      {(icon) => <i class={["tech", icon()]} aria-hidden="true" />}
    </Show>
  );
}
