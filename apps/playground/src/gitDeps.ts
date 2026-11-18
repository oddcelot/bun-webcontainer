/**
 * Git dependencies, as far as a browser gets them. Bun installs one hosted on GitHub (`github:user/repo#ref`, the
 * `user/repo` shorthand, `git+https://github.com/…`, `git://github.com/…`, `https://github.com/user/repo`) from the
 * tarball GitHub makes of the commit, and clones any other (bun/src/install/hosted_git_info.rs, repository.rs). The
 * tarball is what this does too, through the playground's git proxy (codeload sends no CORS headers); cloning over
 * ssh or from another host isn't possible here.
 */
import { untar } from "./tar";

export type GitHubDep = { owner: string; repo: string; /** A branch, tag or commit; "" for the default branch. */ ref: string };

/** Whether a dependency's range is a git one at all (Bun's `Dependency.Version.Tag.infer`). */
export const isGitRange = (range: string) =>
  /^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(range) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(range) || /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?(#.*)?$/.test(range);

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
