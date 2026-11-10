import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { Button } from "@runbun/ui/solid/Button";
import { MANAGE_ACCESS, account, listRepos, loadAccount, signIn, signInAvailable, type GitHubRepo } from "../account";

/**
 * Under "Clone a repository": signed in with GitHub, the repositories the user gave the app (filtered by `filter`, the
 * dialog's field); a click clones one. Otherwise a button to sign in, which also lets private repositories clone.
 */
export function RepoList(props: { filter: string; onPick: (name: string) => void }) {
  const [repos, setRepos] = createSignal<GitHubRepo[] | string | undefined>();
  const [problem, setProblem] = createSignal<string>();
  onSettled(() => {
    void loadAccount().then(() => {
      if (account()) void listRepos().then(setRepos);
    });
  });
  const shown = createMemo(() => {
    const list = repos();
    if (!Array.isArray(list)) return [];
    // The field holds owner/repo or a URL: match what's typed against the names, unless it's the dialog's default.
    const q = props.filter.trim().toLowerCase().replace(/^https:\/\/github\.com\//, "");
    return q && list.some((r) => r.name.toLowerCase().includes(q)) ? list.filter((r) => r.name.toLowerCase().includes(q)) : list;
  });
  return (
    <Show when={signInAvailable()}>
      <div class="repo-list">
        <Show
          when={account()}
          fallback={
            <Show when={account() === null}>
              <p class="hint">Sign in with GitHub to pick from your repositories and clone private ones. You choose which repositories runbun.dev may use.</p>
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
                    <ul aria-label="Your repositories">
                      <For each={shown()} fallback={<li class="hint">None yet: give runbun.dev access to some on GitHub.</li>}>
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
