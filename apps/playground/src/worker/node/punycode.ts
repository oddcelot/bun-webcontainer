// node:punycode (deprecated in Node, still imported by older packages): RFC 3492 Bootstring with IDNA helpers.
const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

const digit = (d: number) => String.fromCharCode(d + 22 + 75 * +(d < 26));
const value = (c: number) => (c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE);

function adapt(delta: number, points: number, first: boolean) {
  let k = 0;
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - TMIN));
  return Math.floor(k + ((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

const ucs2decode = (s: string) => Array.from(s, (c) => c.codePointAt(0)!);
const ucs2encode = (points: number[]) => String.fromCodePoint(...points);

function decode(input: string): string {
  const out: number[] = [];
  const b = Math.max(input.lastIndexOf("-"), 0);
  for (let j = 0; j < b; j++) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError("Illegal input >= 0x80 (not a basic code point)");
    out.push(input.charCodeAt(j));
  }
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) throw new RangeError("Invalid input");
      const d = value(input.charCodeAt(idx++));
      if (d >= BASE) throw new RangeError("Invalid input");
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - old, len, old === 0);
    n += Math.floor(i / len);
    i %= len;
    out.splice(i++, 0, n);
  }
  return ucs2encode(out);
}

function encode(str: string): string {
  const input = ucs2decode(str);
  const out = input.filter((c) => c < 0x80).map((c) => String.fromCharCode(c));
  const basic = out.length;
  let handled = basic;
  if (basic) out.push("-");
  let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
  while (handled < input.length) {
    const m = Math.min(...input.filter((c) => c >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of input) {
      if (c < n) delta++;
      if (c !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t) break;
        out.push(digit(t + ((q - t) % (BASE - t))));
        q = Math.floor((q - t) / (BASE - t));
      }
      out.push(digit(q));
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return out.join("");
}

/** Applies `fn` to each label of a domain, keeping an email's local part as is. */
function mapDomain(domain: string, fn: (label: string) => string) {
  const at = domain.lastIndexOf("@");
  const [local, host] = at < 0 ? ["", domain] : [domain.slice(0, at + 1), domain.slice(at + 1)];
  return local + host.split(/[.。．｡]/).map(fn).join(".");
}

const toASCII = (domain: string) => mapDomain(domain, (l) => (/[^\0-\x7F]/.test(l) ? "xn--" + encode(l) : l));
const toUnicode = (domain: string) => mapDomain(domain, (l) => (/^xn--/i.test(l) ? decode(l.slice(4).toLowerCase()) : l));

export default { version: "2.1.0", ucs2: { decode: ucs2decode, encode: ucs2encode }, decode, encode, toASCII, toUnicode };
