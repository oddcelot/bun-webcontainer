import type { VFS } from "./vfs";

type Log = (level: "sys" | "error", text: string) => void;
export type Repo = { owner: string; repo: string; ref: string; dir: string };

const MAX_FILES = 500;
const MAX_BYTES = 5 * 1024 * 1024;

/** `owner/repo`, `owner/repo@ref`, or a github.com URL (`.../tree/<ref>/<dir>`); the ref defaults to HEAD. */
export function parseRepo(input: string): Repo | null {
  const s = input.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, "").replace(/\.git$|\/$/g, "");
  const m = s.match(/^([\w.-]+)\/([\w.-]+)(?:@([^/]+)|\/tree\/([^/]+)((?:\/[^/]+)*))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] ?? m[4] ?? "HEAD", dir: (m[5] ?? "").replace(/^\//, "") };
}

/** The `?repo=` value for a repo, in the shortest form parseRepo reads back. */
export function repoQuery(r: Repo): string {
  const base = `${r.owner}/${r.repo}`;
  if (r.dir) return `${base}/tree/${r.ref}/${r.dir}`;
  return r.ref === "HEAD" ? base : `${base}@${r.ref}`;
}

/**
 * Loads a public GitHub repo (or a directory of it) into the VFS: one API call lists the tree, files come from
 * raw.githubusercontent.com. Both send CORS headers; codeload's tarballs don't. node_modules and .git are skipped.
 */
export async function loadRepo(vfs: VFS, r: Repo, log: Log): Promise<boolean> {
  const name = `${r.owner}/${r.repo}${r.ref === "HEAD" ? "" : `@${r.ref}`}${r.dir ? `/${r.dir}` : ""}`;
  const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${r.ref}?recursive=1`);
  if (!res.ok) {
    const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    log("error", `[github] ${name}: ${limited ? "API rate limit reached (60/hour without a token)" : `${res.status}; is it a public repo?`}`);
    return false;
  }
  const tree = (await res.json()) as { tree: { path: string; type: string; size?: number }[]; truncated: boolean };
  const prefix = r.dir ? `${r.dir}/` : "";
  const blobs = tree.tree.filter(
    (e) => e.type === "blob" && e.path.startsWith(prefix) && !/(^|\/)(node_modules|\.git)\//.test(e.path) && (e.size ?? 0) <= MAX_BYTES,
  );
  const tooMany = blobs.length > MAX_FILES;
  if (!blobs.length || tooMany) {
    log("error", `[github] ${name}: ${tooMany ? `${blobs.length} files, more than ${MAX_FILES}` : "no files"}`);
    return false;
  }
  if (tree.truncated) log("error", `[github] ${name}: tree listing truncated by GitHub; some files are missing`);

  const dec = new TextDecoder("utf-8", { fatal: true });
  const files = await Promise.all(
    blobs.map(async (e) => {
      const f = await fetch(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${e.path.split("/").map(encodeURIComponent).join("/")}`);
      if (!f.ok) throw new Error(`${e.path}: ${f.status}`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let data: string | Uint8Array = bytes;
      try {
        data = dec.decode(bytes);
      } catch {}
      return [e.path.slice(prefix.length), data] as const;
    }),
  ).catch((e) => void log("error", `[github] ${name}: ${e instanceof Error ? e.message : e}`));
  if (!files) return false;
  vfs.clear();
  for (const [path, data] of files) vfs.write(path, data);
  log("sys", `[github] ${name}: ${files.length} files`);
  return true;
}
