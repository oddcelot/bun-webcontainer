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

/** A query parameter turned off: kept out of the path, at its row's place among the rest (`at`). */
export type OffParam = { name: string; value: string; at: number };

/** The Params rows: the path's query, turned on, with the ones turned off back in their places. */
export function paramRows(path: string, off: readonly OffParam[]): Field[] {
  const rows: Field[] = queryOf(path).map((q) => ({ ...q, on: true }));
  for (const o of [...off].sort((a, b) => a.at - b.at)) rows.splice(Math.min(o.at, rows.length), 0, { name: o.name, value: o.value, on: false });
  return rows;
}

/** Params rows split again: the path with the ones turned on as its query, and the ones turned off (paramRows). */
export function splitParams(path: string, rows: readonly Field[]): { path: string; off: OffParam[] } {
  const off: OffParam[] = [];
  rows.forEach((r, at) => {
    if (!r.on && (r.name || r.value)) off.push({ name: r.name, value: r.value, at });
  });
  return { path: withQuery(path, rows.filter((r) => r.on)), off };
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

const takesBody = (method: string) => method !== "GET" && method !== "HEAD";

/**
 * `draft` as `.http` text (the request panel's Raw view): the request line, a header per line (one turned off
 * commented out with `#`), a blank line, and the editor's body. What Auth adds is noted in a comment above, and a
 * form's rows stand as a comment where the body goes: both are edited in their own sections.
 */
export function toHttp(draft: Draft): string {
  const lines: string[] = [];
  const auth = fromAuth(draft.auth);
  if (auth.header) lines.push(`# Auth adds the ${auth.header[0]} header (edit it under Auth)`);
  if (auth.param) lines.push(`# Auth adds ?${auth.param.name}= to the path (edit it under Auth)`);
  lines.push(`${draft.method} ${draft.path}`);
  for (const h of draft.headers) if (h.name.trim() || h.value) lines.push(`${h.on ? "" : "# "}${h.name}: ${h.value}`);
  if (takesBody(draft.method)) {
    if (draft.bodyMode === "json" || draft.bodyMode === "text") {
      if (draft.body) lines.push("", draft.body);
    } else lines.push("", `# The body is the ${draft.bodyMode === "form" ? "Form" : "Multipart"} rows under Body`);
  }
  return lines.join("\n");
}

/** A path, or a URL's path, query and fragment (`http://localhost:3000/a?x` is `/a?x`), with its leading `/`. */
function pathOf(s: string): string {
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.pathname + u.search + u.hash;
    } catch {}
  }
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * `.http` text read back (toHttp's form) into what it sets: the method and path (when the first line other than a
 * comment is `METHOD path`, optionally ` HTTP/1.1`), the headers (all of them: a `# Name: value` line is one turned
 * off; a line that isn't `Name: value` is skipped) and, after the first blank line, the body. A body while `draft`
 * sends rows makes it JSON or text again (modeOf); one that is only comments leaves the rows be.
 */
export function fromHttp(text: string, draft: Pick<Draft, "bodyMode">): { method?: string; path?: string; headers: Field[]; body?: string; bodyMode?: BodyMode } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (!lines[i]!.trim() || lines[i]!.trimStart().startsWith("#"))) i++;
  const out: ReturnType<typeof fromHttp> = { headers: [] };
  const req = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/.exec(lines[i]?.trim() ?? "");
  if (req) {
    out.method = req[1]!.toUpperCase();
    out.path = pathOf(req[2]!);
    i++;
  }
  for (; i < lines.length && lines[i]!.trim(); i++) {
    const off = /^\s*#\s*/.exec(lines[i]!);
    const m = /^([^:\s]+):\s?(.*)$/.exec(off ? lines[i]!.slice(off[0].length) : lines[i]!.trim());
    if (m) out.headers.push({ name: m[1]!, value: m[2]!, on: !off });
  }
  const rows = draft.bodyMode === "form" || draft.bodyMode === "multipart";
  const body = lines.slice(i + 1).join("\n");
  const onlyComments = body.split("\n").every((l) => !l.trim() || l.trimStart().startsWith("#"));
  if (rows && (onlyComments || i >= lines.length)) return out;
  out.body = i < lines.length ? body : "";
  if (rows) out.bodyMode = modeOf(out.body);
  return out;
}

/** Where a copied request goes: the app run locally with `bun`, on Bun.serve's default port. */
export const LOCAL_ORIGIN = "http://localhost:3000";

/** `s` single-quoted for a POSIX shell. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The headers a copied request sends: Auth's, then the rows (which win), and a content type for the editor's body. */
function copiedHeaders(draft: Draft): [string, string][] {
  const auth = fromAuth(draft.auth);
  const headers = mergeHeaders(auth.header ? [auth.header] : [], sent(draft.headers));
  const type = draft.bodyMode === "json" || draft.bodyMode === "text" ? (draft.body ? TYPES[draft.bodyMode] : undefined) : draft.bodyMode === "form" ? TYPES.form : undefined;
  if (takesBody(draft.method) && type && !headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", type]);
  return headers;
}

const copiedUrl = (draft: Draft, origin: string) => {
  const param = fromAuth(draft.auth).param;
  return origin + (param ? withQuery(draft.path, [...queryOf(draft.path), param]) : draft.path);
};

const formRows = (draft: Draft) => (draft.bodyMode === "form" ? draft.form : draft.multipart).filter((r) => r.on && r.name.trim());

/** `draft` as a curl command against `origin`; a multipart file row reads the file from where curl runs (`-F name=@path`). */
export function toCurl(draft: Draft, origin = LOCAL_ORIGIN): string {
  const args = ["curl"];
  if (draft.method !== "GET") args.push("-X", draft.method);
  args.push(sh(copiedUrl(draft, origin)));
  for (const [k, v] of copiedHeaders(draft)) args.push("-H", sh(`${k}: ${v}`));
  if (takesBody(draft.method)) {
    if (draft.bodyMode === "json" || draft.bodyMode === "text") {
      if (draft.body) args.push("--data-raw", sh(draft.body));
    } else
      for (const r of formRows(draft)) {
        const name = r.name.trim();
        if (draft.bodyMode === "form") args.push("--data-urlencode", sh(`${name}=${r.value}`));
        else if (r.file) args.push("-F", sh(`${name}=@${r.value.trim().replace(/^\/+/, "")}`));
        else args.push("--form-string", sh(`${name}=${r.value}`));
      }
  }
  return args.reduce((out, a, i) => (i === 0 ? a : /^-(H|F|-)/.test(a) ? `${out} \\\n  ${a}` : `${out} ${a}`), "");
}

/** `draft` as a `fetch` call against `origin`, for Bun: a multipart file row is `Bun.file(path)`. */
export function toFetch(draft: Draft, origin = LOCAL_ORIGIN): string {
  const s = (v: string) => JSON.stringify(v);
  const init: string[] = [];
  const before: string[] = [];
  if (draft.method !== "GET") init.push(`method: ${s(draft.method)}`);
  const headers = copiedHeaders(draft);
  if (headers.length) init.push(`headers: {\n${headers.map(([k, v]) => `    ${s(k)}: ${s(v)},`).join("\n")}\n  }`);
  if (takesBody(draft.method)) {
    if (draft.bodyMode === "json" || draft.bodyMode === "text") {
      if (draft.body) init.push(`body: ${draft.bodyMode === "json" && modeOf(draft.body) === "json" ? `JSON.stringify(${draft.body.trim()})` : s(draft.body)}`);
    } else if (draft.bodyMode === "form") {
      init.push(`body: new URLSearchParams([${formRows(draft).map((r) => `[${s(r.name.trim())}, ${s(r.value)}]`).join(", ")}])`);
    } else {
      before.push("const form = new FormData();");
      for (const r of formRows(draft)) before.push(`form.append(${s(r.name.trim())}, ${r.file ? `Bun.file(${s(r.value.trim().replace(/^\/+/, ""))})` : s(r.value)});`);
      init.push("body: form");
    }
  }
  const call = init.length ? `await fetch(${s(copiedUrl(draft, origin))}, {\n${init.map((l) => `  ${l},`).join("\n")}\n});` : `await fetch(${s(copiedUrl(draft, origin))});`;
  return [...before, `const res = ${call}`].join("\n");
}
