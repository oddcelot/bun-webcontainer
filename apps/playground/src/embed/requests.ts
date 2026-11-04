// The embed's `requests` option: the requests a reader can try, each in its own preview tab
// (`GET /user/1; POST /form {"hello":"Elysia"}`).

/** A preset request: a method, a path and a body (sent as the request bar sends one, preview.ts sendRequest). */
export type PresetRequest = { method: string; path: string; body: string };

/**
 * `requests` as presets, in order. Entries split at a `;` followed by (optional whitespace,) an uppercase method,
 * whitespace and `/`, so a `;` inside a body doesn't split it. An entry is METHOD, whitespace, a path from `/` to the
 * next whitespace, then optionally whitespace and a body (the rest, trimmed). A malformed entry is skipped with a
 * warning.
 */
export function parseRequests(list: string): PresetRequest[] {
  const out: PresetRequest[] = [];
  for (const raw of list.split(/;(?=\s*[A-Z]+\s+\/)/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([A-Z]+)\s+(\/\S*)(?:\s+([\s\S]*))?$/.exec(entry);
    if (m) out.push({ method: m[1]!, path: m[2]!, body: (m[3] ?? "").trim() });
    else console.warn(`[embed] requests: skipped ${JSON.stringify(entry)}, not "METHOD /path [body]"`);
  }
  return out;
}
