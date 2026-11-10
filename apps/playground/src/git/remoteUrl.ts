// What "Open a repository" with Git history (and `?git=`) accepts: an https:// URL on a host the git proxy reaches
// (worker/gitProxy.ts), `host/owner/repo`, or GitHub's `owner/repo`. Kept to the canonical
// `https://<host>/<owner>/<repo>` (no `.git`, no trailing slash), which is also the project's id.

export const GIT_HOSTS = ["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"];

/** The repository's https URL, or why `input` isn't one the playground can clone. */
export function gitUrl(input: string): { url: string } | { error: string } {
  let s = input.trim().replace(/\.git\/?$/, "").replace(/\/+$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `github.com/${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "not a repository URL" };
  }
  if (!u.hostname.includes(".")) return { error: "not a repository URL" };
  if (u.protocol !== "https:") return { error: "only https:// repositories" };
  if (!GIT_HOSTS.includes(u.hostname)) return { error: `only ${GIT_HOSTS.join(", ")}` };
  // GitHub URLs of a page inside the repository (…/tree/main/src) name the repository by their first two parts.
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return { error: "no owner/repository in the URL" };
  const path = u.hostname === "github.com" || u.hostname === "codeberg.org" || u.hostname === "bitbucket.org" ? parts.slice(0, 2) : parts.slice(0, parts.indexOf("-") > 0 ? parts.indexOf("-") : undefined);
  return { url: `https://${u.hostname}/${path.join("/")}` };
}

/** `owner/repo` for a GitHub URL, `host/owner/repo` otherwise: how the gallery and Storage name it. */
export const gitName = (url: string) => url.replace(/^https:\/\//, "").replace(/^github\.com\//, "");
