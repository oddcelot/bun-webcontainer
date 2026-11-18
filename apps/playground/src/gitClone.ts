import { VFS } from "@runbun/vfs";
import { git, release } from "./git/git";

// A git dependency that isn't GitHub's (gitDeps.ts gitRepoDep): cloned by git.wasm into a project of its own, over
// https through the git proxy, and checked out at its ref, as Bun clones one (repository.rs). The install resolves it
// here and installs it from bun.lock right after: one clone serves both, by its ref and then by its commit.

/** A checkout: its commit (full hash) and its files, `.git` left out. */
export type Checkout = { commit: string; files: Map<string, Uint8Array> };

const checkouts = new Map<string, Promise<Checkout>>();

async function checkout(url: string, ref: string, name: string): Promise<Checkout> {
  const vfs = new VFS();
  try {
    const run = async (args: string[]) => {
      const r = await git(vfs, args, { colors: false });
      return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() };
    };
    const cloned = await run(["clone", ...(ref ? [] : ["--depth", "1"]), url, "."]);
    if (!cloned.ok) throw new Error(`"git clone" for "${name}" failed: ${cloned.err.split("\n").pop()}`);
    if (ref) {
      // Bun asks its bare clone, where every branch is a local one; here a branch other than the default is origin's.
      let commit: string | undefined;
      for (const rev of [ref, `origin/${ref}`]) {
        const r = await run(["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
        if (r.ok && r.out) {
          commit = r.out;
          break;
        }
      }
      if (!commit) throw new Error(`no commit matching "${ref}" found for "${name}" (but repository exists)`);
      const switched = await run(["checkout", "--detach", commit]);
      if (!switched.ok) throw new Error(`"git checkout" for "${name}" failed: ${switched.err.split("\n").pop()}`);
    }
    const head = await run(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(head.out)) throw new Error(`"git rev-parse HEAD" for "${name}" failed: ${head.err}`);
    const files = new Map<string, Uint8Array>();
    for (const path of vfs.list()) if (path !== ".git" && !path.startsWith(".git/")) files.set(path, vfs.readBytes(path)!);
    return { commit: head.out, files };
  } finally {
    await release(vfs);
  }
}

/** The checkout of `url` (https) at `ref` ("" for the default branch, or a commit from bun.lock). `name`: for errors. */
export function gitCheckout(url: string, ref: string, name: string): Promise<Checkout> {
  const key = `${url}#${ref}`;
  let got = checkouts.get(key);
  if (!got) {
    checkouts.set(key, (got = checkout(url, ref, name)));
    got.then((c) => checkouts.set(`${url}#${c.commit}`, got!), () => checkouts.delete(key));
  }
  return got;
}
