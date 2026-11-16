// node:crypto's ciphers, signatures and key objects over crypto-wasm, under node (Memory64; bun lacks it):
//  1. the playground's node:crypto shim (apps/playground/src/worker/node/crypto.ts) runs fixtures/crypto/cases.ts and its
//     output must equal what native Bun prints for the same file (the shim's errors included);
//  2. random ciphers, keys and chunkings against node's own crypto (which has chacha20-poly1305 and the odd GCM IV
//     lengths that Bun lacks);
//  3. a few raw calls of the ABI and the module's size.
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const wasmPath = new URL("../../target/wasm64-unknown-unknown/release/bun_crypto_wasm.wasm", import.meta.url);
const app = new URL("../../apps/playground/", import.meta.url);

// The playground's imports leave out `.ts` (Vite resolves them).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return next(specifier + ".ts", context);
      } catch {}
    }
    return next(specifier, context);
  },
});

const { setCryptoWasm, wcall } = await import(new URL("src/worker/node/cryptoWasm.ts", app).href);
const shim = (await import(new URL("src/worker/node/crypto.ts", app).href)).default;
const { run, chacha } = await import(new URL("fixtures/crypto/cases.ts", app).href);

const bytes = readFileSync(wasmPath);
let compiles = 0;
setCryptoWasm(() => (compiles++, new WebAssembly.Module(bytes)));

// ---- 1. cases.ts against native Bun
const main = new URL("fixtures/crypto/main.ts", app).pathname;
const native = spawnSync("bun", [main], { encoding: "utf8", cwd: new URL("fixtures/crypto/", app).pathname });
assert.equal(native.status, 0, native.stderr);
const expected = native.stdout.trimEnd().split("\n").filter((l: string) => !l.startsWith("chacha20:"));
const got: string[] = run(shim);
let bad = 0;
for (let i = 0; i < Math.max(expected.length, got.length); i++) {
  if (expected[i] !== got[i]) {
    bad++;
    console.log(`line ${i}:\n  bun:  ${expected[i]}\n  shim: ${got[i]}`);
  }
}
assert.equal(bad, 0, `${bad} lines differ from native Bun`);
assert.equal(chacha(shim), "chacha20: ok");
assert.equal(compiles, 1, "the module compiles once");
console.log(`${got.length} cases match native Bun; chacha20-poly1305 matches RFC 8439`);

// ---- 2. random cipher inputs against node
const rnd = (n: number) => nodeCrypto.randomBytes(n);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const split = (b: Buffer) => {
  const parts: Buffer[] = [];
  for (let i = 0; i < b.length; ) {
    const n = 1 + Math.floor(Math.random() * 40);
    parts.push(b.subarray(i, i + n));
    i += n;
  }
  return parts;
};
let ciphers = 0;
for (let i = 0; i < 400; i++) {
  const name = pick(["aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes-128-ecb", "aes-256-ecb", "aes-128-ctr", "aes-192-ctr", "aes-256-ctr", "aes-128-cfb", "aes-192-cfb", "aes-256-cfb", "aes-128-ofb", "aes-256-ofb", "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "chacha20-poly1305"]);
  const bits = name === "chacha20-poly1305" ? 256 : Number(name.split("-")[1]);
  const key = rnd(bits / 8);
  const gcm = name.endsWith("gcm");
  const iv = name.endsWith("ecb") ? null : rnd(name === "chacha20-poly1305" ? 12 : gcm ? pick([12, 12, 12, 8, 16, 1, 33]) : 16);
  const aead = gcm || name === "chacha20-poly1305";
  const aad = aead && Math.random() < 0.7 ? rnd(Math.floor(Math.random() * 50)) : undefined;
  const plain = rnd(Math.floor(Math.random() * 200));
  const noPad = !aead && /cbc|ecb/.test(name) && Math.random() < 0.3;
  const body = noPad ? plain.subarray(0, plain.length - (plain.length % 16)) : plain;
  const tagLength = aead ? pick([16, 16, 12, 8, 4].filter((n) => name !== "chacha20-poly1305" || n === 16)) : undefined;
  const opts = tagLength ? { authTagLength: tagLength } : undefined;
  const enc = (lib: typeof nodeCrypto, chunks: Buffer[]) => {
    const c = lib.createCipheriv(name, key, iv, opts as never) as nodeCrypto.CipherGCM;
    if (noPad) c.setAutoPadding(false);
    if (aad) c.setAAD(aad);
    const ct = Buffer.concat([...chunks.map((p) => c.update(p)), c.final()]);
    return { ct, tag: aead ? c.getAuthTag() : undefined };
  };
  const want = enc(nodeCrypto, [body]);
  const mine = enc(shim, split(body));
  assert.equal(mine.ct.toString("hex"), want.ct.toString("hex"), `${name} ciphertext`);
  assert.equal(mine.tag?.toString("hex"), want.tag?.toString("hex"), `${name} tag`);
  const d = shim.createDecipheriv(name, key, iv, opts);
  if (noPad) d.setAutoPadding(false);
  if (aad) d.setAAD(aad);
  if (aead) d.setAuthTag(want.tag!);
  const back = Buffer.concat([...split(want.ct).map((p) => d.update(p)), d.final()]);
  assert.equal(back.toString("hex"), body.toString("hex"), `${name} decrypts`);
  if (aead) {
    const bad = shim.createDecipheriv(name, key, iv, opts);
    if (aad) bad.setAAD(aad);
    const t = Buffer.from(want.tag!);
    t[0] ^= 1;
    bad.setAuthTag(t);
    bad.update(want.ct);
    assert.throws(() => bad.final(), /Unsupported state or unable to authenticate data/);
  }
  ciphers++;
}
console.log(`${ciphers} random cipher runs match node`);

// ---- 2b. random keys: node's signatures verify here, ours verify in node, PEM/DER are byte-identical
const msg = rnd(100);
for (const [type, opts, alg] of [["rsa", { modulusLength: 1024 }, "sha256"], ["ec", { namedCurve: "P-256" }, "sha256"], ["ec", { namedCurve: "P-384" }, "sha384"], ["ed25519", {}, null]] as const) {
  const n = nodeCrypto.generateKeyPairSync(type as "rsa", opts as never);
  const mine = shim.createPrivateKey(n.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.equal(mine.export({ type: "pkcs8", format: "pem" }), n.privateKey.export({ type: "pkcs8", format: "pem" }));
  for (const t of type === "ec" ? ["pkcs8", "sec1"] : type === "rsa" ? ["pkcs8", "pkcs1"] : ["pkcs8"]) {
    assert.equal(mine.export({ type: t, format: "der" }).toString("hex"), n.privateKey.export({ type: t, format: "der" } as never).toString("hex"), `${type} ${t}`);
  }
  assert.deepEqual(mine.export({ format: "jwk" }), n.privateKey.export({ format: "jwk" }));
  const sig = shim.sign(alg, msg, mine);
  assert.ok(nodeCrypto.verify(alg, msg, n.publicKey, sig), `${type}: node verifies ours`);
  assert.ok(shim.verify(alg, msg, shim.createPublicKey(n.publicKey.export({ type: "spki", format: "pem" })), nodeCrypto.sign(alg, msg, n.privateKey)), `${type}: we verify node's`);
  if (type === "rsa") {
    const pss = { padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
    assert.ok(nodeCrypto.verify("sha256", msg, { key: n.publicKey, ...pss }, shim.sign("sha256", msg, { key: mine, ...pss })));
    assert.equal(nodeCrypto.privateDecrypt(n.privateKey, shim.publicEncrypt(n.publicKey.export({ type: "spki", format: "pem" }), Buffer.from("rsa"))).toString(), "rsa");
    assert.equal(shim.privateDecrypt(mine, nodeCrypto.publicEncrypt(n.publicKey, Buffer.from("rsa"))).toString(), "rsa");
    assert.equal(shim.privateDecrypt({ key: mine, oaepHash: "sha384" }, nodeCrypto.publicEncrypt({ key: n.publicKey, oaepHash: "sha384" }, Buffer.from("rsa"))).toString(), "rsa");
  }
}
console.log("random keys, signatures and encryption interoperate with node");

// ---- 3. the ABI: an error comes back with its code
let code = "";
try {
  wcall(1, "aes-128-cbc", new Uint8Array(3), new Uint8Array(16), 1, 0);
} catch (e) {
  code = (e as { code: string }).code;
}
assert.equal(code, "ERR_CRYPTO_INVALID_KEYLEN");
console.log(`module: ${(bytes.length / 1024).toFixed(0)} KiB`);
