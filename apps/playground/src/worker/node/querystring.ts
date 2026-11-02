const unescape = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const prim = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" && isFinite(v) ? "" + v : typeof v === "bigint" ? "" + v : typeof v === "boolean" ? (v ? "true" : "false") : "");

function parse(str: string, sep = "&", eq = "=", opts?: { maxKeys?: number }): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  if (typeof str !== "string" || !str) return out;
  let parts = str.split(sep);
  const max = opts?.maxKeys ?? 1000;
  if (max > 0) parts = parts.slice(0, max);
  for (const part of parts) {
    if (!part) continue;
    const i = part.indexOf(eq);
    const k = unescape((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
    const v = i < 0 ? "" : unescape(part.slice(i + eq.length).replace(/\+/g, " "));
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

function stringify(obj?: Record<string, unknown>, sep = "&", eq = "="): string {
  if (obj === null || typeof obj !== "object") return "";
  return Object.keys(obj)
    .map((k) => {
      const v = obj[k];
      const ks = encodeURIComponent(k) + eq;
      return Array.isArray(v) ? v.map((x) => ks + encodeURIComponent(prim(x))).join(sep) : ks + encodeURIComponent(prim(v));
    })
    .filter(Boolean)
    .join(sep);
}

export default { parse, stringify, escape: encodeURIComponent, unescape, decode: parse, encode: stringify };
