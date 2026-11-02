// Writes Bun.semver results for a pseudo-random corpus, for diff.mjs to compare against the wasm build.
const vs = ["0.0.1","0.1.0","1.0.0","1.0.0-alpha","1.0.0-alpha.1","1.0.0-beta.2","1.0.0-rc.1","1.2.3","1.2.3+b.5","1.10.0","2.0.0","2.0.0-0","2.5.1","3.0.0-x.7.z.92","10.20.30","v1.2.3","1.2","garbage"];
const rs = ["*","^1.0.0","~1.2.0","^0.1.0","^0.0.1",">=1.0.0 <2.0.0","1.x || >=2.5.0","1.2.3 - 2.0.0","<1.0.0",">1.0.0-alpha","^1.0.0-alpha","~1","1.2.x","=1.2.3","latest","",">=2.0.0-0","^2 || ^3"];
const order = [], sat = [];
for (const a of vs) for (const b of vs) { let o; try { o = Bun.semver.order(a, b); } catch { o = 2; } order.push([a, b, o]); }
for (const v of vs) for (const r of rs) sat.push([v, r, Bun.semver.satisfies(v, r)]);
await Bun.write("expected.json", JSON.stringify({ order, sat }));
