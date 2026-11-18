/**
 * Git dependencies, as far as a browser gets them. Bun installs one hosted on GitHub (`github:user/repo#ref`, the
 * `user/repo` shorthand, `git+https://github.com/…`, `git://github.com/…`, `https://github.com/user/repo`) from the
 * tarball GitHub makes of the commit, and clones any other (bun/src/install/hosted_git_info.rs, repository.rs). The
 * tarball is what this does too, through the playground's git proxy (codeload sends no CORS headers). The others it
 * clones with git.wasm (gitClone.ts), over https through the same proxy, from the hosts that reaches; bun.lock gets
 * what native Bun writes, an ssh URL included.
 */
import { untar } from "./tar";

export type GitHubDep = { owner: string; repo: string; /** A branch, tag or commit; "" for the default branch. */ ref: string };

/** Whether a dependency's range is a git one at all (Bun's `Dependency.Version.Tag.infer`). */
export const isGitRange = (range: string) =>
  /^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(range) ||
  /^[\w.-]+\/[\w.-]+(#.*)?$/.test(range) ||
  /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?(#.*)?$/.test(range) ||
  /^https?:\/\/[^#]+\.git(#.*)?$/.test(range);

/** The GitHub repository and ref of a git range, or why it can't be installed here. */
export function githubDep(range: string): GitHubDep | { error: string } {
  const [spec, ref = ""] = splitHash(range);
  const m =
    spec.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
    spec.match(/^([\w-][\w.-]*)\/([\w.-]+?)(?:\.git)?$/) ??
    spec.match(/^(?:git\+https?|git|https?):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) {
    const how = /^git\+ssh:|^ssh:|^git@/.test(spec) ? "over ssh" : `from ${spec.match(/^(\w+):(?!\/)/)?.[1] ?? spec.match(/:\/\/(?:[^@/]+@)?([^/:]+)/)?.[1] ?? "that host"}`;
    return { error: `git dependencies ${how} need a git clone, which doesn't work in the browser (only GitHub's, from its tarballs)` };
  }
  if (ref.startsWith("semver:")) return { error: `"semver:" ranges of git dependencies aren't supported` };
  return { owner: m[1], repo: m[2], ref: decodeURIComponent(ref) };
}

/** The hosts git.wasm clones a dependency from (through worker/gitProxy.ts; GitHub's come as tarballs). */
const CLONE_HOSTS = ["gitlab.com", "codeberg.org", "bitbucket.org"];
const SHORTHAND_HOSTS: Record<string, string> = { gitlab: "gitlab.com", bitbucket: "bitbucket.org" };

/** A git dependency git.wasm clones: `lock` is what bun.lock writes before `#<commit>`, `clone` the https URL. */
export type GitRepoDep = { lock: string; clone: string; /** A branch, tag or commit; "" for the default branch. */ ref: string; /** The package's name when it has no package.json (the URL's last part, as Bun names it). */ fallbackName: string };

/**
 * A git dependency that isn't GitHub's, as Bun records it (repository.rs): `git+https://…` and `https://….git` as
 * `git+https://…`, `git+ssh://…` as it is, and the `gitlab:`/`bitbucket:` shorthands as `git+ssh://git@<host>/…`.
 * Cloned over https whatever bun.lock says (as Bun falls back to it), from a host the git proxy reaches.
 */
export function gitRepoDep(range: string): GitRepoDep | { error: string } {
  const [spec, ref = ""] = splitHash(range);
  let lock: string;
  let host: string;
  let path: string;
  const short = spec.match(/^(gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/);
  const url = spec.match(/^(?:git\+)?(https?|ssh):\/\/(?:([^@/]+)@)?([^/:]+)(\/[^:]+)$/);
  if (short) {
    host = SHORTHAND_HOSTS[short[1]];
    path = `/${short[2]}`;
    lock = `git+ssh://git@${host}${path}`;
  } else if (url) {
    host = url[3];
    path = url[4];
    lock = `git+${spec.replace(/^git\+/, "")}`;
  } else return { error: `git dependencies like ${spec} need a git clone over ssh or git://, which the browser can't make (an https URL can be cloned)` };
  if (!CLONE_HOSTS.includes(host)) return { error: `git dependencies from ${host} need a git clone, which the playground's git proxy makes only from ${["github.com", ...CLONE_HOSTS].join(", ")}` };
  return { lock, clone: cloneUrl(host, path), ref: decodeURIComponent(ref), fallbackName: path.split("/").filter(Boolean).pop()! };
}

/** `git+https://host/a/b.git#<commit>` (or `git+ssh://`) from bun.lock: the https URL to clone and the commit. */
export function lockedGitRepo(resolution: string): { clone: string; commit: string } | undefined {
  const m = resolution.match(/^git\+(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(\/[^#:]+)#([0-9a-f]{40})$/);
  return m && CLONE_HOSTS.includes(m[1]) ? { clone: cloneUrl(m[1], m[2]), commit: m[3] } : undefined;
}

/** The https URL of a repository, ending in `.git`: GitLab redirects git's requests without it, which the proxy doesn't follow. */
const cloneUrl = (host: string, path: string) => `https://${host}${path.replace(/\/+$/, "").replace(/(?<!\.git)$/, ".git")}`;

const splitHash = (s: string): [string, string?] => {
  const i = s.indexOf("#");
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
};

/** The path of the tarball of `ref` on codeload.github.com, as native Bun downloads it (its root folder names the commit). */
export const tarballPath = ({ owner, repo, ref }: GitHubDep) => `${owner}/${repo}/legacy.tar.gz/${ref ? encodeURIComponent(ref) : "HEAD"}`;

/** `github:user/repo#abc1234` from bun.lock: the tarball to fetch. */
export function lockedGitHub(resolution: string): GitHubDep | undefined {
  const m = resolution.match(/^github:([\w.-]+)\/([\w.-]+)#([0-9a-f]+)$/);
  return m ? { owner: m[1], repo: m[2], ref: m[3] } : undefined;
}

/**
 * What bun.lock records of a GitHub tarball (gunzipped `tar`): its root folder (`owner-repo-abc1234`, the third field)
 * and the commit's short hash, which ends it. Undefined if the tarball isn't GitHub's.
 */
export function tarballRoot(tar: Uint8Array): { folder: string; commit: string } | undefined {
  for (const { name } of untar(tar)) {
    const folder = name.split("/")[0];
    const commit = folder.match(/-([0-9a-f]{7,40})$/)?.[1];
    return commit ? { folder, commit } : undefined;
  }
}
