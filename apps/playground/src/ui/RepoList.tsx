import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Button } from "@runbun/ui/solid/Button";
import { Input } from "@runbun/ui/solid/Input";
import { MANAGE_ACCESS, account, listRepos, loadAccount, signIn, signInAvailable, type GitHubRepo } from "../account";

/**
 * Under "Clone a repository": signed in with GitHub, the repositories the user gave the app, with a search over their
 * names and descriptions; a click clones one. Otherwise a button to sign in, which also lets private repositories clone.
 */
export function RepoList(props: { onPick: (name: string) => void }) {
  const [repos, setRepos] = createSignal<GitHubRepo[] | string | undefined>();
  const [query, setQuery] = createSignal("");
  const [problem, setProblem] = createSignal<string>();
  onSettled(() => {
    void loadAccount().then(() => {
      if (account()) void listRepos().then(setRepos);
    });
  });
  const shown = createMemo(() => {
    const list = repos();
    if (!Array.isArray(list)) return [];
    // Every word must appear in the name or the description, in any order.
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((r) => {
      const text = `${r.name} ${r.description ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  return (
    <Show when={signInAvailable()}>
      <div class="repo-list">
        <Show
          when={account()}
          fallback={
            <Show when={account() === null}>
              <p class="hint">Sign in to pick from your repositories and clone private ones.</p>
              <Button
                onClick={async () => {
                  setProblem(await signIn());
                }}
              >
                <i class="i-lucide-github" aria-hidden="true" /> Sign in with GitHub
              </Button>
              <Show when={problem()}>
                <p class="dialog-error" role="alert">
                  {problem()}
                </p>
              </Show>
            </Show>
          }
        >
          {(a) => (
            <>
              <p class="hint">
                Your repositories ({a().name}). <a href={MANAGE_ACCESS} target="_blank" rel="noopener">Change which ones runbun.dev may use</a>
              </p>
              <Show when={repos()} fallback={<p class="hint">Loading…</p>}>
                {(r) => (
                  <Show when={Array.isArray(r())} fallback={<p class="dialog-error">{r() as string}</p>}>
                    <Input
                      type="search"
                      class="repo-search"
                      placeholder="Search your repositories"
                      aria-label="Search your repositories"
                      spellcheck={false}
                      autocomplete="off"
                      value={query()}
                      onInput={(e) => setQuery(e.currentTarget.value)}
                      // Enter picks the only match rather than submitting the dialog's field.
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (shown().length === 1) props.onPick(shown()[0].name);
                      }}
                    />
                    <ul aria-label="Your repositories">
                      <For
                        each={shown()}
                        fallback={<li class="hint">{query() ? "No repository matches." : "No repositories yet. Grant runbun.dev access on GitHub."}</li>}
                      >
                        {(repo) => (
                          <li>
                            <button type="button" onClick={() => props.onPick(repo.name)} title={repo.description ?? repo.name}>
                              <i class={repo.private ? "i-lucide-lock" : "i-lucide-book-marked"} aria-hidden="true" />
                              <span class="name">{repo.name}</span>
                              <Show when={repo.private}>
                                <span class="sr-only">(private)</span>
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
