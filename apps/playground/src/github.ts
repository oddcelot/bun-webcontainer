import type { VFS } from "@runbun/vfs";

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

const label = (r: Repo) => `${r.owner}/${r.repo}${r.ref === "HEAD" ? "" : `@${r.ref}`}${r.dir ? `/${r.dir}` : ""}`;

/**
 * The files loadRepo would load (paths in the repo, `dir/` included), from one API call; an error message if there are
 * none, too many, or GitHub said no.
 */
export async function listRepo(r: Repo): Promise<{ paths: string[]; truncated: boolean } | string> {
  const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${r.ref}?recursive=1`);
  if (!res.ok) {
    const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    return limited ? "GitHub rate limit reached (60 requests an hour without a token)" : `${res.status}. Is the repo public?`;
  }
  const tree = (await res.json()) as { tree: { path: string; type: string; size?: number }[]; truncated: boolean };
  const prefix = r.dir ? `${r.dir}/` : "";
  const paths = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !/(^|\/)(node_modules|\.git)\//.test(e.path) && (e.size ?? 0) <= MAX_BYTES)
    .map((e) => e.path);
  if (paths.length > MAX_FILES) return `${paths.length} files, more than ${MAX_FILES}`;
  return paths.length ? { paths, truncated: tree.truncated } : "no files";
}

/** One file of the repo (`path` as listRepo gives it), from raw.githubusercontent.com: text when it decodes as UTF-8. */
export async function repoFile(r: Repo, path: string): Promise<string | Uint8Array> {
  const f = await fetch(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!f.ok) throw new Error(`${path}: ${f.status}`);
  const bytes = new Uint8Array(await f.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
}

/**
 * Loads a public GitHub repo (or a directory of it) into the VFS: one API call lists the tree, files come from
 * raw.githubusercontent.com. Both send CORS headers; codeload's tarballs don't. node_modules and .git are skipped.
 */
export async function loadRepo(vfs: VFS, r: Repo, log: Log): Promise<boolean> {
  const name = label(r);
  const list = await listRepo(r);
  if (typeof list === "string") {
    log("error", `[github] ${name}: ${list}`);
    return false;
  }
  if (list.truncated) log("error", `[github] ${name}: GitHub cut the file list short, so some files are missing`);
  const prefix = r.dir ? `${r.dir}/` : "";
  const files = await Promise.all(list.paths.map(async (path) => [path.slice(prefix.length), await repoFile(r, path)] as const)).catch(
    (e) => void log("error", `[github] ${name}: ${e instanceof Error ? e.message : e}`),
  );
  if (!files) return false;
  vfs.clear();
  for (const [path, data] of files) vfs.write(path, data);
  log("sys", `[github] ${name}: ${files.length} files`);
  return true;
}
