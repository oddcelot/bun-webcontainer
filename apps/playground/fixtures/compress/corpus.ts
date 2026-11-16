// The inputs both sides compress: the same bytes natively and in the playground.
export const LEVELS = [1, 3, 9, 19, 22];
export const QUALITIES = [0, 5, 11];

export function corpus(): Record<string, Uint8Array> {
  const words = "the quick brown fox jumps over the lazy dog while seven wizards quietly box jars of mixed vegetables".split(" ");
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  const text = Array.from({ length: 6000 }, () => words[next() % words.length]).join(" ");
  const random = new Uint8Array(70_000);
  for (let i = 0; i < random.length; i++) random[i] = next();
  const mixed = new Uint8Array(text.length + random.length + 50_000);
  mixed.set(new TextEncoder().encode(text));
  mixed.set(random, text.length);
  mixed.fill(9, text.length + random.length);
  return {
    empty: new Uint8Array(0),
    byte: new Uint8Array([97]),
    short: new TextEncoder().encode("hello hello hello hello world"),
    text: new TextEncoder().encode(text),
    random,
    mixed,
    zeros: new Uint8Array(1 << 20),
  };
}
