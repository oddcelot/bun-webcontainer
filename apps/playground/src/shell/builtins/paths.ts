// Paths the way rm, mv and cp print and join them (bun_paths).

/** node's path.normalize for absolute paths: `.` and `..` resolved, a trailing `/` kept. */
export function normalizeKeepSlash(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  const out = "/" + parts.join("/");
  return path.endsWith("/") && parts.length ? out + "/" : out;
}

/** `operand` against the cwd, normalized the way bun_paths' join does (node's path.join). */
export function resolveOperand(cwd: string, operand: string): string {
  return normalizeKeepSlash(operand.startsWith("/") ? operand : `${cwd}/${operand}`);
}

/** The last component, trailing `/`s ignored (bun_paths basename). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || (path.startsWith("/") ? "/" : "");
}
