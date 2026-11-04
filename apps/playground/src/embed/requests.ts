// The embed's `requests` option: the requests a reader can try, each in its own preview tab
// (`GET /user/1; POST /form {"hello":"Elysia"}`).

/**
 * A preset request: a method, a path, a body (sent as the request bar sends one: JSON when it parses, else text) and
 * the headers given with `-H`, when there are any.
 */
export type PresetRequest = { method: string; path: string; body: string; headers?: [string, string][] };

/**
 * `requests` as presets, in order. Entries split at a `;` followed by (optional whitespace,) an uppercase method,
 * whitespace and `/`, so a `;` inside a body doesn't split it. An entry is METHOD, whitespace, a path from `/` to the
 * next whitespace, then optionally headers, each `-H` and a quoted `Name: value` (`-H "Authorization: Bearer x"`, or in
 * single quotes), and a body (the rest, trimmed). A malformed entry is skipped with a warning, and so is a header with
 * no `:`.
 */
export function parseRequests(list: string): PresetRequest[] {
  const out: PresetRequest[] = [];
  for (const raw of list.split(/;(?=\s*[A-Z]+\s+\/)/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([A-Z]+)\s+(\/\S*)(?:\s+([\s\S]*))?$/.exec(entry);
    if (m) {
      let rest = (m[3] ?? "").trim();
      const headers: [string, string][] = [];
      for (let h; (h = /^-H\s+(?:"([^"]*)"|'([^']*)')\s*/.exec(rest)); rest = rest.slice(h[0].length)) {
        const line = h[1] ?? h[2]!;
        const colon = line.indexOf(":");
        if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
        else console.warn(`[embed] requests: skipped the header ${JSON.stringify(line)}, not "Name: value"`);
      }
      out.push({ method: m[1]!, path: m[2]!, body: rest, ...(headers.length ? { headers } : {}) });
    }
    else console.warn(`[embed] requests: skipped ${JSON.stringify(entry)}, not "METHOD /path [body]"`);
  }
  return out;
}
