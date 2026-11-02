// The most frequent words of a text. Shown on the Astro guide, imported with ?raw.
const text = "the quick brown fox jumps over the lazy dog and the dog sleeps";

const counts = new Map<string, number>();
for (const word of text.split(/\s+/)) counts.set(word, (counts.get(word) ?? 0) + 1);

const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
for (const [word, count] of ranked) console.log(word, count);
