// The parts of a preview request besides its method and body: the query of its path, as rows the request panel edits
// (ui/Preview.tsx), and the headers readers add, carried to the running server through the service worker (sw.ts).

/** A query parameter or header row. A header row can be turned off without removing it. */
export type Field = { name: string; value: string; on: boolean };

/** `path` split at its query (`?`) and fragment (`#`), each kept with its mark. */
function split(path: string): { pathname: string; query: string; hash: string } {
  const h = path.indexOf("#");
  const hash = h < 0 ? "" : path.slice(h);
  const rest = h < 0 ? path : path.slice(0, h);
  const q = rest.indexOf("?");
  return { pathname: q < 0 ? rest : rest.slice(0, q), query: q < 0 ? "" : rest.slice(q), hash };
}

/** The query parameters of `path`, decoded, in order (as `URLSearchParams` reads them). */
export function queryOf(path: string): { name: string; value: string }[] {
  return [...new URLSearchParams(split(path).query)].map(([name, value]) => ({ name, value }));
}

/** Encoded for a query, leaving the characters that read better as they are (`/`, `:`, `@`, `,`, `$`); spaces as `+`. */
const encode = (s: string) =>
  encodeURIComponent(s)
    .replace(/%(2F|3A|40|2C|24)/gi, (m) => decodeURIComponent(m))
    .replace(/%20/g, "+");

/** `path` with its query replaced by `params` (none: no `?`). A row with no name and no value is left out. */
export function withQuery(path: string, params: { name: string; value: string }[]): string {
  const { pathname, hash } = split(path);
  const query = params
    .filter((p) => p.name || p.value)
    .map((p) => (p.value ? `${encode(p.name)}=${encode(p.value)}` : encode(p.name)))
    .join("&");
  return pathname + (query ? `?${query}` : "") + hash;
}

/**
 * The request header that carries the reader's headers to the service worker: `fetch` drops the ones a page may not
 * set (`Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`…), so they all go in this one, which sw.ts takes out again and
 * sets on the request the server sees.
 */
export const HEADERS_HEADER = "x-runbun-headers";

/** The headers that go with a request: the rows turned on, with a name. */
export const sent = (headers: readonly Field[]): [string, string][] => headers.filter((h) => h.on && h.name.trim()).map((h) => [h.name.trim(), h.value]);

/** `HEADERS_HEADER`'s value for `headers` (percent-encoded JSON: a header value is bytes, so no other characters). */
export const packHeaders = (headers: [string, string][]): string => encodeURIComponent(JSON.stringify(headers));

/** The headers packed in `value`, or none when it isn't what packHeaders writes. */
export function unpackHeaders(value: string | null): [string, string][] {
  if (!value) return [];
  try {
    const list: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(list) ? list.filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string") : [];
  } catch {
    return [];
  }
}

/** `list` with `extra` set over it: a header in both takes `extra`'s value (names compared case-insensitively). */
export function mergeHeaders(list: [string, string][], extra: [string, string][]): [string, string][] {
  if (!extra.length) return list;
  const names = new Set(extra.map(([k]) => k.toLowerCase()));
  return [...list.filter(([k]) => !names.has(k.toLowerCase())), ...extra];
}

/**
 * The name the reader's `Cookie` header travels under from the service worker to the runner: the runner replaces any
 * `Cookie` a request brings with its jar's (runner.ts withCookies; the browser's own cookies for the playground aren't
 * the app's), and joins this one in.
 */
export const PANEL_COOKIE = "x-runbun-cookie";

/** Two `Cookie` header values as one; a cookie in both takes `over`'s value. */
export function joinCookies(base: string | undefined, over: string | undefined): string {
  const pairs = new Map<string, string>();
  for (const part of `${base ?? ""}; ${over ?? ""}`.split(";")) {
    const pair = part.trim();
    if (pair) pairs.set(pair.split("=", 1)[0]!.trim(), pair);
  }
  return [...pairs.values()].join("; ");
}
