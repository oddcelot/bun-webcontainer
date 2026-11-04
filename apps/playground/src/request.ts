// The parts of a preview request besides its method and body: the query of its path, as rows the request panel edits
// (ui/Preview.tsx), and the headers readers add, carried to the running server through the service worker (sw.ts).

/**
 * A query parameter, header or form row. A row other than a query parameter can be turned off without removing it; a
 * multipart row with `file` sends the project file at the path in `value`.
 */
export type Field = { name: string; value: string; on: boolean; file?: boolean };

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

/** How the request panel's Body is sent: the editor's text as JSON or plain text, or rows as a form. */
export type BodyMode = "json" | "text" | "form" | "multipart";

/** The mode a body given as text (an embed preset's) is sent in: JSON when it parses (or is empty), else text. */
export function modeOf(text: string): BodyMode {
  if (!text.trim()) return "json";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

/** The request panel's Auth: written into a header (or, for an API key, a header or a query parameter) when sent. */
export type Auth = {
  type: "none" | "bearer" | "basic" | "apikey";
  token: string;
  user: string;
  pass: string;
  key: string;
  value: string;
  in: "header" | "query";
};

export const noAuth = (): Auth => ({ type: "none", token: "", user: "", pass: "", key: "", value: "", in: "header" });

/** `s` as UTF-8, base64-encoded (`btoa` takes Latin-1 only). */
const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** What `auth` adds to a request: a header, a query parameter, or nothing while it's incomplete. */
export function fromAuth(auth: Auth): { header?: [string, string]; param?: { name: string; value: string } } {
  switch (auth.type) {
    case "bearer":
      return auth.token.trim() ? { header: ["Authorization", `Bearer ${auth.token.trim()}`] } : {};
    case "basic":
      return auth.user || auth.pass ? { header: ["Authorization", `Basic ${base64(`${auth.user}:${auth.pass}`)}`] } : {};
    case "apikey": {
      const name = auth.key.trim();
      if (!name) return {};
      return auth.in === "query" ? { param: { name, value: auth.value } } : { header: [name, auth.value] };
    }
    default:
      return {};
  }
}

/** The request panel's state for one request (ui/previews.ts PreviewTab has these). */
export type Draft = {
  method: string;
  path: string;
  body: string;
  bodyMode: BodyMode;
  form: readonly Field[];
  multipart: readonly Field[];
  headers: readonly Field[];
  auth: Auth;
};

/** A draft as it goes out: the path with Auth's query parameter, the headers, and the body with its content type. */
export type Built = { path: string; headers: [string, string][]; body?: BodyInit; type?: string };

const TYPES: Record<Exclude<BodyMode, "multipart">, string> = {
  json: "application/json",
  text: "text/plain",
  form: "application/x-www-form-urlencoded",
};

/**
 * `draft` as it is sent. Auth comes first, so a header row of the same name wins over it. A body goes only with a
 * method that takes one: the editor's text (when there is any), or the rows turned on with a name. A multipart body
 * has no `type`: `fetch` writes it, with the boundary. `read` gives a project file's bytes for a file row; a file it
 * doesn't have throws, naming it.
 */
export function build(draft: Draft, read: (path: string) => Uint8Array | undefined): Built {
  const auth = fromAuth(draft.auth);
  const path = auth.param ? withQuery(draft.path, [...queryOf(draft.path), auth.param]) : draft.path;
  const headers = mergeHeaders(auth.header ? [auth.header] : [], sent(draft.headers));
  if (draft.method === "GET" || draft.method === "HEAD") return { path, headers };
  const mode = draft.bodyMode;
  if (mode === "json" || mode === "text") return draft.body ? { path, headers, body: draft.body, type: TYPES[mode] } : { path, headers };
  const rows = (mode === "form" ? draft.form : draft.multipart).filter((r) => r.on && r.name.trim());
  if (mode === "form") return { path, headers, body: new URLSearchParams(rows.map((r) => [r.name.trim(), r.value])).toString(), type: TYPES.form };
  const data = new FormData();
  for (const r of rows) {
    if (!r.file) {
      data.append(r.name.trim(), r.value);
      continue;
    }
    const file = r.value.trim().replace(/^\/+/, "");
    const bytes = read(file);
    if (!bytes) throw new Error(`No file ${JSON.stringify(file)} in the project for the form field ${JSON.stringify(r.name.trim())}`);
    data.append(r.name.trim(), new File([bytes as Uint8Array<ArrayBuffer>], file.split("/").pop()!));
  }
  return { path, headers, body: data };
}
