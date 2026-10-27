const a = 2 ** 10, b = +"0x1F", c = "a" + "b", d = `x${1}y`;
export async function* gen() { for await (const x of [1, 2]) yield x?.y ?? 0; }
label: for (const k in {}) { if (k) continue label; }
export const re = /(?<year>\d{4})/u, big = 123n, sep = 1_000_000;
class P { #priv = 1; static { this.s = 2; } get v() { return this.#priv; } }
export { P, a, b, c, d };
