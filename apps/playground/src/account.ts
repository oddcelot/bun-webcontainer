import { createSignal } from "solid-js";
import { BASE } from "./base";

// Signed in with GitHub (worker/auth.ts: Better Auth, cookies only): who, and the calls that change it. The token
// itself stays in an httpOnly cookie this code can't read; the git proxy and /api/github/* use it. Asked lazily, when
// the Git view or the repository dialog first needs it.

export type Account = { name: string; email: string; image?: string | null };
export type GitHubRepo = { name: string; private: boolean; description: string | null; pushed: string; url: string };

const api = (path: string) => new URL(`${BASE}api/${path}`, location.href).href;

/** undefined: not asked yet; null: nobody is signed in (or sign-in isn't set up). */
const [account, setAccount] = createSignal<Account | null | undefined>(undefined);
/** Whether the server has sign-in at all (its secrets set). */
const [available, setAvailable] = createSignal(true);
export { account, available as signInAvailable };

let asked: Promise<void> | undefined;
/** Reads who is signed in, once (again with `force`). */
export function loadAccount(force = false): Promise<void> {
  if (asked && !force) return asked;
  const reading = fetch(api("auth/get-session"), { credentials: "same-origin" })
    .then(async (r) => {
      if (r.status === 503 || r.status === 404) setAvailable(false);
      const s = r.ok ? ((await r.json()) as { user?: Account } | null) : null;
      setAccount(s?.user ? { name: s.user.name, email: s.user.email, image: s.user.image } : null);
    })
    .catch(() => void setAccount(null));
  asked = reading;
  return reading;
}

/** Off to GitHub to sign in (and grant the app its repositories), then back to this page. */
export async function signIn(): Promise<string | undefined> {
  const r = await fetch(api("auth/sign-in/social"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: location.href }),
  });
  const body = (await r.json().catch(() => ({}))) as { url?: string; error?: string; message?: string };
  if (!r.ok || !body.url) return body.message ?? body.error ?? `sign-in failed (${r.status})`;
  location.assign(body.url);
}

export async function signOut(): Promise<void> {
  await fetch(api("auth/sign-out"), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  setAccount(null);
  repos = undefined;
}

let repos: Promise<GitHubRepo[] | string> | undefined;
/** The repositories the user gave the app, most recently pushed first (cached until sign-out); or why not. */
export function listRepos(force = false): Promise<GitHubRepo[] | string> {
  if (repos && !force) return repos;
  repos = fetch(api("github/repos"), { credentials: "same-origin" }).then(async (r) => {
    if (r.status === 401) {
      setAccount(null);
      return "not signed in";
    }
    if (!r.ok) return `couldn't list your repositories (${r.status})`;
    return (await r.json()) as GitHubRepo[];
  });
  return repos;
}

/** Where the user changes which repositories the app may use. */
export const MANAGE_ACCESS = "https://github.com/settings/installations";
