import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle, DialogTrigger } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Tip } from "@runbun/ui/solid/Tip";
import { examples, repoExamples } from "../examples";
import { parseRepo, repoQuery } from "../github";
import { gitName } from "../git/remoteUrl";
import { heldProjects, listProjects, projectsKept, type SavedProject } from "../persist";
import { clearPkgCache, pkgCacheInfo } from "../pkgCache";
import { clearStore, storeInfo } from "../pkgStore";
import { clearTranspileCache, transpileCacheInfo } from "../transpileCache";
import { AppContext } from "./context";

/**
 * What this browser keeps for the playground (saved projects, the package and transpile caches) and how much space
 * that takes, with a way to delete each project, clear each cache, or clear it all. Its button is in the header.
 */
export function Storage(props: { id?: string }) {
  return (
    <Dialog
      class="storage"
      trigger={
        <Tip as={DialogTrigger} id={props.id} tip="Storage: saved projects and caches" aria-label="Storage">
          <i class="i-lucide-hard-drive" aria-hidden="true" />
        </Tip>
      }
    >
      <StorageForm />
    </Dialog>
  );
}

const units = ["B", "KB", "MB", "GB"];
function size(n: number) {
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

const repoLabels = new Map(
  Object.entries(repoExamples).flatMap(([key, label]) => {
    const r = parseRepo(key);
    return r ? [[repoQuery(r), label.replace(/ \(from GitHub\)$/, "")] as const] : [];
  }),
);

/** A saved project's name, from its id (persist.ts: `demo`, `example:<name>`, `repo:<query>`, `git:<url>`, `share:<hash>`). */
function label(id: string): { name: string; detail?: string } {
  if (id === "demo") return { name: "Confetti demo" };
  const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  if (kind === "example") return { name: examples[rest] ?? rest, detail: rest.startsWith("starter-") ? "starter" : "example" };
  if (kind === "repo") return { name: repoLabels.get(rest) ?? rest, detail: "GitHub" };
  if (kind === "share") return { name: "Shared project", detail: `link ${rest.slice(0, 8)}` };
  if (kind === "git") return { name: gitName(rest), detail: "Git clone" };
  return { name: id };
}

type Caches = { packages: number; transpiled: number };

// Inside Dialog.Content, so each opening measures afresh (the content unmounts on close).
function StorageForm() {
  const app = useContext(AppContext);
  const [usage, setUsage] = createSignal<{ used: number; quota: number } | null>(null);
  const [kept, setKept] = createSignal(false);
  const [projects, setProjects] = createSignal<SavedProject[] | null>(null);
  const [held, setHeld] = createSignal(new Set<string>());
  const [current, setCurrent] = createSignal<string | null>(null);
  const [caches, setCaches] = createSignal<Caches | null>(null);
  // The project whose Delete asks to be clicked again, or "all" for Clear all.
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function measure() {
    const [estimate, list, locks, k, pkg, store, transpiled] = await Promise.all([
      navigator.storage?.estimate?.().catch(() => undefined),
      listProjects().catch(() => []),
      heldProjects(),
      projectsKept(),
      pkgCacheInfo().catch(() => ({ bytes: 0 })),
      storeInfo().catch(() => ({ bytes: 0 })),
      transpileCacheInfo().catch(() => ({ bytes: 0 })),
    ]);
    setUsage(estimate ? { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null);
    setProjects(list);
    setHeld(locks);
    setKept(k);
    setCaches({ packages: pkg.bytes + store.bytes, transpiled: transpiled.bytes });
  }

  onSettled(() => {
    void measure();
    void app.storage?.current().then(setCurrent);
  });

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setConfirming(null);
    try {
      await work();
      await measure();
    } finally {
      setBusy(false);
    }
  }

  const remove = (id: string) => {
    if (confirming() !== id) return setConfirming(id);
    void act(() => app.storage!.remove(id));
  };
  const elsewhere = (id: string) => held().has(id) && id !== current();

  return (
    <>
      <DialogTitle>Storage</DialogTitle>
      <DialogDescription>
        Saved projects and caches this browser keeps for the playground.
        <Show when={usage()}>{(u) => <>{` ${size(u().used)} in use of ${size(u().quota)} available.`}</>}</Show>
      </DialogDescription>
      <p class="storage-kept">
        <Show
          when={kept()}
          fallback={
            <>
              The browser may clear saved projects when space runs low.{" "}
              <button type="button" class="link" onClick={() => void projectsKept(true).then(setKept)}>
                Ask to keep them
              </button>
            </>
          }
        >
          <i class="i-lucide-shield-check" aria-hidden="true" /> The browser keeps saved projects until you clear them.
        </Show>
      </p>

      <h3 class="storage-heading">Projects</h3>
      <Show when={projects()} fallback={<p class="storage-empty">Measuring…</p>}>
        {(list) => (
          <Show when={list().length} fallback={<p class="storage-empty">No saved projects.</p>}>
            <ul class="storage-list">
              <For each={list()}>
                {(p) => (
                  <li class="storage-row">
                    <span class="storage-name">
                      {label(p.id).name}
                      <small>
                        {[label(p.id).detail, `${p.files} files`, size(p.bytes), p.modified ? new Date(p.modified).toLocaleDateString() : ""].filter(Boolean).join(" · ")}
                        <Show when={p.id === current()}> · open here</Show>
                        <Show when={elsewhere(p.id)}> · open in another tab</Show>
                      </small>
                    </span>
                    <Tip
                      class={["button", "storage-delete", { confirming: confirming() === p.id }]}
                      disabled={busy() || elsewhere(p.id)}
                      tip={
                        elsewhere(p.id)
                          ? "Close the other tab to delete it"
                          : p.id === current()
                            ? "Delete the saved files and reload this project from its source"
                            : "Delete its saved files"
                      }
                      aria-label={`Delete ${label(p.id).name}`}
                      onClick={() => remove(p.id)}
                    >
                      <Show when={confirming() === p.id} fallback={<i class="i-lucide-trash-2" aria-hidden="true" />}>
                        Delete?
                      </Show>
                    </Tip>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>

      <h3 class="storage-heading">Caches</h3>
      <ul class="storage-list">
        <li class="storage-row">
          <span class="storage-name">
            Packages
            <small>npm downloads, shared by every project · {caches() ? size(caches()!.packages) : "…"}</small>
          </span>
          <Button disabled={busy() || !caches()?.packages} onClick={() => void act(() => Promise.all([clearPkgCache(), clearStore()]))}>
            Clear
          </Button>
        </li>
        <li class="storage-row">
          <span class="storage-name">
            Transpiled modules
            <small>large files, kept so a reload is faster · {caches() ? size(caches()!.transpiled) : "…"}</small>
          </span>
          <Button disabled={busy() || !caches()?.transpiled} onClick={() => void act(clearTranspileCache)}>
            Clear
          </Button>
        </li>
      </ul>

      <Show
        when={confirming() === "all"}
        fallback={
          <DialogActions>
            <Button class="danger" disabled={busy()} onClick={() => setConfirming("all")}>
              Clear all…
            </Button>
            <DialogClose>Close</DialogClose>
          </DialogActions>
        }
      >
        <p class="storage-warning">
          Deletes every saved project (but those open in other tabs) and both caches, then reloads. Edits you haven't
          downloaded as a zip or shared are gone for good.
        </p>
        <DialogActions>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button class="danger" disabled={busy()} onClick={() => void act(() => app.storage!.clearAll())}>
            Clear all
          </Button>
        </DialogActions>
      </Show>
    </>
  );
}
