// node:crypto's ciphers, signatures and key objects, as lines of output. The same cases run under native Bun (the
// expected lines), in the playground, and (crates/crypto-wasm/test.ts) over the worker's shim in node: they print
// only what is deterministic, or a verdict (a signature made at random is checked by verifying it).
import * as data from "./data";

type Crypto = typeof import("node:crypto");

export function run(crypto: Crypto): string[] {
  const lines: string[] = [];
  const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
  const t = (label: string, f: () => unknown) => {
    try {
      const r = f();
      lines.push(`${label}: ${typeof r === "string" ? r : JSON.stringify(r)}`);
    } catch (e) {
      const err = e as Error & { code?: string; reason?: string; library?: string };
      lines.push(`${label}: ! ${err.constructor.name} ${err.code} ${err.message}${err.reason ? ` [${err.library}|${err.reason}]` : ""}`);
    }
  };
  const msg = Buffer.from(data.message);
  const hx = (s: string) => Buffer.from(s, "hex");

  // ---- Ciphers: fixed key and IV
  const key = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i * 7 + 1));
  const iv16 = key(16).reverse();
  const plain = Buffer.from("The quick brown fox jumps over the lazy dog, twice: the quick brown fox.");
  for (const bits of [128, 192, 256]) {
    for (const mode of ["cbc", "ecb", "ctr", "cfb", "ofb"]) {
      if (bits === 192 && (mode === "cfb")) continue; // not in Bun's list
      t(`aes-${bits}-${mode}`, () => {
        const name = `aes-${bits}-${mode}`;
        const iv = mode === "ecb" ? null : iv16;
        const c = crypto.createCipheriv(name, key(bits / 8), iv);
        const ct = Buffer.concat([c.update(plain.subarray(0, 10)), c.update(plain.subarray(10)), c.final()]);
        const d = crypto.createDecipheriv(name, key(bits / 8), iv);
        const back = Buffer.concat([d.update(ct), d.final()]);
        return `${ct.toString("hex")} ${back.equals(plain)}`;
      });
    }
  }
  t("cbc strings", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    const a = c.update("héllo wörld", "utf8", "base64");
    const b = c.update("!!", "utf8", "base64");
    return a + "|" + b + "|" + c.final("base64");
  });
  t("cbc hex out", () => {
    const c = crypto.createCipheriv("aes-256-cbc", key(32), iv16);
    return c.update("abc", "utf8", "hex") + c.final("hex");
  });
  t("cbc decrypt hex in", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    const hex = c.update("round trip ünïcode", "utf8", "hex") + c.final("hex");
    const d = crypto.createDecipheriv("aes-128-cbc", key(16), iv16);
    return hex + " " + (d.update(hex, "hex", "utf8") + d.final("utf8"));
  });
  t("no padding", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(Buffer.alloc(32, 9)), c.final()]);
    const d = crypto.createDecipheriv("aes-128-cbc", key(16), iv16);
    d.setAutoPadding(false);
    const back = Buffer.concat([d.update(ct), d.final()]);
    return `${ct.toString("hex")} ${back.equals(Buffer.alloc(32, 9))}`;
  });
  t("empty", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    return c.final("hex");
  });
  t("aes128 alias", () => {
    const c = crypto.createCipheriv("aes128", key(16), iv16);
    return c.update("x", "utf8", "hex") + c.final("hex");
  });
  t("uppercase name", () => {
    const c = crypto.createCipheriv("AES-128-CBC", key(16), iv16);
    return c.update("x", "utf8", "hex") + c.final("hex");
  });
  t("ctr large", () => {
    const c = crypto.createCipheriv("aes-128-ctr", key(16), Buffer.alloc(16, 0xff));
    return sha(Buffer.concat([c.update(Buffer.alloc(100000, 7)), c.final()]));
  });
  t("secret key object", () => {
    const c = crypto.createCipheriv("aes-128-cbc", crypto.createSecretKey(key(16)), iv16);
    return c.update("x", "utf8", "hex") + c.final("hex");
  });
  t("string key and iv", () => {
    const c = crypto.createCipheriv("aes-128-cbc", "0123456789abcdef", "fedcba9876543210");
    return c.update("x", "utf8", "hex") + c.final("hex");
  });

  // ---- GCM
  for (const bits of [128, 192, 256]) {
    t(`aes-${bits}-gcm`, () => {
      const c = crypto.createCipheriv(`aes-${bits}-gcm`, key(bits / 8), key(12));
      c.setAAD(Buffer.from("header"));
      const ct = Buffer.concat([c.update(plain.subarray(0, 5)), c.update(plain.subarray(5)), c.final()]);
      const tag = c.getAuthTag();
      const d = crypto.createDecipheriv(`aes-${bits}-gcm`, key(bits / 8), key(12));
      d.setAAD(Buffer.from("header"));
      d.setAuthTag(tag);
      const back = Buffer.concat([d.update(ct), d.final()]);
      return `${ct.toString("hex")} ${tag.toString("hex")} ${back.equals(plain)}`;
    });
  }
  t("gcm no aad", () => {
    const c = crypto.createCipheriv("aes-128-gcm", key(16), key(12));
    const ct = c.update("", "utf8", "hex") + c.final("hex");
    return `${ct} ${c.getAuthTag().toString("hex")}`;
  });
  t("gcm 16-byte iv", () => {
    const c = crypto.createCipheriv("aes-128-gcm", key(16), key(16));
    const ct = c.update("sixteen", "utf8", "hex") + c.final("hex");
    return `${ct} ${c.getAuthTag().toString("hex")}`;
  });
  t("gcm 8-byte iv", () => {
    const c = crypto.createCipheriv("aes-256-gcm", key(32), key(8));
    const ct = c.update("eight", "utf8", "hex") + c.final("hex");
    return `${ct} ${c.getAuthTag().toString("hex")}`;
  });
  t("gcm short tag", () => {
    const c = crypto.createCipheriv("aes-128-gcm", key(16), key(12), { authTagLength: 8 });
    c.update("short");
    c.final();
    const tag = c.getAuthTag();
    const d = crypto.createDecipheriv("aes-128-gcm", key(16), key(12), { authTagLength: 8 });
    d.setAuthTag(tag);
    return `${tag.toString("hex")} ${tag.length}`;
  });
  t("gcm bad tag", () => {
    const c = crypto.createCipheriv("aes-128-gcm", key(16), key(12));
    const ct = Buffer.concat([c.update("tamper me"), c.final()]);
    const tag = c.getAuthTag();
    tag[0] ^= 1;
    const d = crypto.createDecipheriv("aes-128-gcm", key(16), key(12));
    d.setAuthTag(tag);
    d.update(ct);
    return d.final().toString();
  });
  t("gcm bad aad", () => {
    const c = crypto.createCipheriv("aes-128-gcm", key(16), key(12));
    c.setAAD(Buffer.from("a"));
    const ct = Buffer.concat([c.update("aad"), c.final()]);
    const d = crypto.createDecipheriv("aes-128-gcm", key(16), key(12));
    d.setAAD(Buffer.from("b"));
    d.setAuthTag(c.getAuthTag());
    d.update(ct);
    return d.final().toString();
  });
  t("gcm no tag", () => {
    const d = crypto.createDecipheriv("aes-128-gcm", key(16), key(12));
    d.update(Buffer.alloc(4));
    return d.final().toString();
  });
  t("gcm bad tag length", () => crypto.createDecipheriv("aes-128-gcm", key(16), key(12)).setAuthTag(Buffer.alloc(3)));
  t("getAuthTag early", () => crypto.createCipheriv("aes-128-gcm", key(16), key(12)).getAuthTag());
  t("getAuthTag on cbc", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    c.final();
    return c.getAuthTag();
  });

  // ---- Errors
  t("bad key length", () => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(15), iv16));
  t("bad iv length", () => crypto.createCipheriv("aes-128-cbc", key(16), Buffer.alloc(8)));
  t("bad iv ecb", () => crypto.createCipheriv("aes-128-ecb", key(16), Buffer.alloc(16)));
  t("unknown cipher", () => crypto.createCipheriv("foo-cbc", key(16), iv16));
  t("bad decrypt", () => {
    const d = crypto.createDecipheriv("aes-128-cbc", key(16), iv16);
    d.update(Buffer.alloc(16));
    return d.final();
  });
  t("wrong final block", () => {
    const d = crypto.createDecipheriv("aes-128-cbc", key(16), iv16);
    d.update(Buffer.alloc(15));
    return d.final();
  });
  t("no padding encrypt", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    c.setAutoPadding(false);
    c.update(Buffer.alloc(15));
    return c.final();
  });
  t("update after final", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    c.final();
    return c.update("x");
  });
  t("final twice", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    c.final();
    return c.final();
  });
  t("bad data type", () => (crypto.createCipheriv("aes-128-cbc", key(16), iv16) as unknown as { update(d: unknown): unknown }).update(5));

  // ---- Stream interface
  t("cipher stream", () => {
    const c = crypto.createCipheriv("aes-128-cbc", key(16), iv16);
    const out: Buffer[] = [];
    c.on("data", (d: Buffer) => out.push(d));
    c.write(plain.subarray(0, 20));
    c.end(plain.subarray(20));
    return `${typeof c.pipe} ${typeof c.on} ${sha(Buffer.concat(out)) === sha(Buffer.concat(out))}`;
  });

  // ---- Keys
  const rsa = crypto.createPrivateKey(data.rsaPrivate);
  const ec256 = crypto.createPrivateKey(data.ec256Private);
  const ec384 = crypto.createPrivateKey(data.ec384Private);
  const ed = crypto.createPrivateKey(data.edPrivate);
  const privs = { rsa, ec256, ec384, ed };
  for (const [name, k] of Object.entries(privs)) {
    t(`${name} info`, () => [k.type, k.asymmetricKeyType, JSON.stringify(k.asymmetricKeyDetails, (_, v) => (typeof v === "bigint" ? Number(v) : v)), k.symmetricKeySize, Object.prototype.toString.call(k)]);
    t(`${name} pkcs8 pem`, () => (k.export({ type: "pkcs8", format: "pem" }) as string) === (data as Record<string, string>)[`${name}Private`]);
    t(`${name} pkcs8 der`, () => sha(k.export({ type: "pkcs8", format: "der" }) as Buffer));
    const pub = crypto.createPublicKey(k);
    t(`${name} spki`, () => [pub.type, sha(pub.export({ type: "spki", format: "der" }) as Buffer), (pub.export({ type: "spki", format: "pem" }) as string).split("\n")[0]]);
    t(`${name} jwk`, () => JSON.stringify(Object.fromEntries(Object.entries(k.export({ format: "jwk" })).sort())));
    t(`${name} public jwk`, () => JSON.stringify(Object.fromEntries(Object.entries(pub.export({ format: "jwk" })).sort())));
    t(`${name} jwk roundtrip`, () => {
      const back = crypto.createPrivateKey({ key: k.export({ format: "jwk" }), format: "jwk" });
      const pback = crypto.createPublicKey({ key: pub.export({ format: "jwk" }), format: "jwk" });
      return [back.equals(k), pback.equals(pub), k.equals(pub)];
    });
    t(`${name} public from pem`, () => crypto.createPublicKey(pub.export({ type: "spki", format: "pem" })).equals(pub));
    t(`${name} public from der`, () => crypto.createPublicKey({ key: pub.export({ type: "spki", format: "der" }) as Buffer, format: "der", type: "spki" }).equals(pub));
    t(`${name} private from der`, () => crypto.createPrivateKey({ key: k.export({ type: "pkcs8", format: "der" }) as Buffer, format: "der", type: "pkcs8" }).equals(k));
  }
  t("rsa pkcs1 pem", () => {
    const p = rsa.export({ type: "pkcs1", format: "pem" }) as string;
    return [p.split("\n")[0], sha(rsa.export({ type: "pkcs1", format: "der" }) as Buffer), crypto.createPrivateKey(p).equals(rsa), crypto.createPublicKey(p).equals(crypto.createPublicKey(rsa))];
  });
  t("rsa pkcs1 public", () => {
    const pub = crypto.createPublicKey(rsa);
    const p = pub.export({ type: "pkcs1", format: "pem" }) as string;
    return [p.split("\n")[0], sha(pub.export({ type: "pkcs1", format: "der" }) as Buffer), crypto.createPublicKey(p).equals(pub)];
  });
  for (const [name, k] of [["ec256", ec256], ["ec384", ec384]] as const) {
    t(`${name} sec1`, () => {
      const p = k.export({ type: "sec1", format: "pem" }) as string;
      return [p.split("\n")[0], sha(k.export({ type: "sec1", format: "der" }) as Buffer), crypto.createPrivateKey(p).equals(k)];
    });
  }
  t("export wrong type", () => ec256.export({ type: "pkcs1", format: "pem" }));
  t("secret key", () => {
    const k = crypto.createSecretKey(Buffer.from("secret"));
    return [k.type, k.symmetricKeySize, k.asymmetricKeyType, (k.export() as Buffer).toString(), JSON.stringify(k.export({ format: "jwk" })), k.equals(crypto.createSecretKey("secret", "utf8"))];
  });
  t("hmac with key object", () => crypto.createHmac("sha256", crypto.createSecretKey(Buffer.from("k"))).update("m").digest("hex") === crypto.createHmac("sha256", "k").update("m").digest("hex"));
  t("key object ctor", () => new (crypto.KeyObject as unknown as new (...a: unknown[]) => unknown)());
  t("junk pem", () => crypto.createPrivateKey("junk"));
  t("junk public pem", () => crypto.createPublicKey({ key: "x", format: "pem" }));
  t("public as private", () => crypto.createPrivateKey(crypto.createPublicKey(rsa).export({ type: "spki", format: "pem" })));
  t("secret as private", () => crypto.createPrivateKey(crypto.createSecretKey(Buffer.from("x")) as never));
  t("der without type", () => crypto.createPrivateKey({ key: rsa.export({ type: "pkcs8", format: "der" }) as Buffer, format: "der" } as never));

  // ---- Signatures
  const sigKeys: [string, crypto.KeyObject, string | null][] = [["rsa", rsa, "sha256"], ["ed", ed, null]];
  for (const [name, k, alg] of sigKeys) {
    t(`${name} sign`, () => {
      const s = crypto.sign(alg, msg, k);
      return [sha(s), s.length, crypto.verify(alg, msg, crypto.createPublicKey(k), s), crypto.verify(alg, Buffer.from("other"), k, s)];
    });
  }
  for (const alg of ["sha1", "sha224", "sha256", "sha384", "sha512"]) {
    t(`rsa pkcs1 ${alg}`, () => {
      const s = crypto.sign(alg, msg, rsa);
      const names = [`RSA-${alg.toUpperCase()}`, alg.toUpperCase(), `${alg}WithRSAEncryption`];
      return [sha(s), ...names.map((n) => crypto.createSign(n).update(msg).sign(rsa, "hex") === s.toString("hex"))];
    });
  }
  t("createSign streaming", () => {
    const s = crypto.createSign("RSA-SHA256");
    s.update("the message ");
    s.update("that is signed");
    const sig = s.sign(rsa);
    const v = crypto.createVerify("sha256");
    v.update("the message that is ");
    v.update(Buffer.from("signed"));
    return [sha(sig), v.verify(crypto.createPublicKey(rsa), sig), crypto.createVerify("sha256").update("x").verify(rsa, sig)];
  });
  t("sign encodings", () => {
    const hex = crypto.createSign("sha256").update(msg).sign(rsa, "hex");
    const b64 = crypto.createSign("sha256").update(msg).sign(rsa, "base64");
    return [hex.length, Buffer.from(b64, "base64").toString("hex") === hex, crypto.createVerify("sha256").update(msg).verify(rsa, hex, "hex"), crypto.createVerify("sha256").update(msg).verify(rsa, b64, "base64")];
  });
  t("sign with pem", () => {
    const sig = crypto.sign("sha256", msg, data.rsaPrivate);
    return [sha(sig), crypto.verify("sha256", msg, crypto.createPublicKey(data.rsaPrivate).export({ type: "spki", format: "pem" }), sig)];
  });
  t("verify tampered", () => {
    const sig = crypto.sign("sha256", msg, rsa);
    sig[5] ^= 1;
    return crypto.verify("sha256", msg, rsa, sig);
  });
  t("verify short signature", () => crypto.verify("sha256", msg, rsa, Buffer.alloc(10)));
  t("sign callback", () => typeof crypto.sign("sha256", msg, rsa, () => {}));
  t("pss salt 0", () => {
    const opts = { key: rsa, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 0 };
    const s = crypto.sign("sha256", msg, opts);
    return [sha(s), crypto.verify("sha256", msg, opts, s)];
  });
  t("pss roundtrip", () => {
    const opts = { key: rsa, padding: crypto.constants.RSA_PKCS1_PSS_PADDING };
    const s = crypto.sign("sha256", msg, opts);
    const s2 = crypto.sign("sha256", msg, { ...opts, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
    return [crypto.verify("sha256", msg, opts, s), crypto.verify("sha256", msg, opts, s2), crypto.verify("sha256", msg, { ...opts, saltLength: 32 }, s2), crypto.verify("sha256", msg, { ...opts, saltLength: 5 }, s2), crypto.verify("sha256", msg, rsa, s)];
  });
  t("pss from node", () => {
    const pss = crypto.constants.RSA_PKCS1_PSS_PADDING;
    return [
      crypto.verify("sha256", msg, { key: rsa, padding: pss }, hx(data.pssMax)),
      crypto.verify("sha256", msg, { key: rsa, padding: pss, saltLength: 20 }, hx(data.pss20)),
      crypto.verify("sha256", msg, { key: rsa, padding: pss, saltLength: 20 }, hx(data.pssMax)),
      crypto.verify("sha384", msg, { key: rsa, padding: pss, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, hx(data.pss384)),
    ];
  });
  const ecs: [string, crypto.KeyObject, string, string, string][] = [["ec256", ec256, "sha256", data.ec256Der, data.ec256P1363], ["ec384", ec384, "sha384", data.ec384Der, data.ec384P1363]];
  for (const [name, k, alg, der, p1363] of ecs) {
    const pub = crypto.createPublicKey(k);
    t(`${name} ecdsa`, () => {
      const s = crypto.sign(alg, msg, k);
      const p = crypto.sign(alg, msg, { key: k, dsaEncoding: "ieee-p1363" });
      return [
        s[0] === 0x30,
        p.length,
        crypto.verify(alg, msg, pub, s),
        crypto.verify(alg, msg, { key: pub, dsaEncoding: "ieee-p1363" }, p),
        crypto.verify(alg, msg, pub, p),
        crypto.verify(alg, Buffer.from("other"), pub, s),
      ];
    });
    t(`${name} from node`, () => [
      crypto.verify(alg, msg, pub, hx(der)),
      crypto.verify(name === "ec256" ? "sha256" : "sha512", msg, { key: pub, dsaEncoding: "ieee-p1363" }, hx(p1363)),
      crypto.verify("sha256", msg, pub, hx(der)),
    ]);
    t(`${name} createSign`, () => {
      const s = crypto.createSign(alg).update(msg).sign(k);
      return [crypto.createVerify(alg).update(msg).verify(pub, s),];
    });
  }
  t("ed25519 from fixture", () => {
    const sig = crypto.sign(null, msg, ed);
    return [sig.toString("hex").slice(0, 32), crypto.verify(null, msg, ed, sig)];
  });
  t("ed25519 with algorithm", () => crypto.verify("sha256", msg, ed, crypto.sign(null, msg, ed)));
  t("rsa null algorithm", () => sha(crypto.sign(null, msg, rsa)));
  t("invalid digest", () => crypto.sign("sha999", msg, rsa));
  t("createSign invalid digest", () => crypto.createSign("nope"));
  t("sign with public key", () => crypto.sign("sha256", msg, crypto.createPublicKey(rsa)));
  t("sign with secret key", () => crypto.sign("sha256", msg, crypto.createSecretKey(Buffer.from("x"))));

  // ---- RSA encryption
  const rsaPub = crypto.createPublicKey(rsa);
  t("oaep roundtrip", () => {
    const ct = crypto.publicEncrypt(rsaPub, Buffer.from("secret"));
    const ct2 = crypto.publicEncrypt({ key: rsaPub, oaepHash: "sha256", oaepLabel: Buffer.from("l") }, Buffer.from("secret"));
    return [
      ct.length,
      crypto.privateDecrypt(rsa, ct).toString(),
      crypto.privateDecrypt({ key: rsa, oaepHash: "sha256", oaepLabel: Buffer.from("l") }, ct2).toString(),
      crypto.publicEncrypt(rsaPub, Buffer.from("x")).equals(ct),
    ];
  });
  t("oaep from node", () => [
    crypto.privateDecrypt(rsa, hx(data.oaepSha1)).toString(),
    crypto.privateDecrypt({ key: rsa, oaepHash: "sha256", oaepLabel: Buffer.from("label") }, hx(data.oaepSha256)).toString(),
  ]);
  t("pkcs1 decrypt refused", () => crypto.privateDecrypt({ key: rsa, padding: crypto.constants.RSA_PKCS1_PADDING }, hx(data.pkcs1)));
  t("pkcs1 roundtrip", () => {
    const opts = { padding: crypto.constants.RSA_PKCS1_PADDING };
    const ct = crypto.publicEncrypt({ key: rsaPub, ...opts }, Buffer.from("v1.5"));
    return [ct.length, crypto.publicEncrypt({ key: rsaPub, ...opts }, Buffer.from("v1.5")).equals(ct)];
  });
  t("publicEncrypt with private pem", () => crypto.privateDecrypt(data.rsaPrivate, crypto.publicEncrypt(data.rsaPrivate, Buffer.from("pem"))).toString());
  t("oaep wrong label", () => crypto.privateDecrypt({ key: rsa, oaepLabel: Buffer.from("x") }, hx(data.oaepSha1)));
  t("oaep too long", () => crypto.publicEncrypt(rsaPub, Buffer.alloc(300)));

  // ---- Generation (random: only shapes and round trips)
  t("generate rsa", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    const sig = crypto.sign("sha256", msg, privateKey);
    return [publicKey.type, privateKey.type, JSON.stringify(privateKey.asymmetricKeyDetails, (_, v) => (typeof v === "bigint" ? Number(v) : v)), crypto.verify("sha256", msg, publicKey, sig), crypto.privateDecrypt(privateKey, crypto.publicEncrypt(publicKey, Buffer.from("g"))).toString()];
  });
  for (const curve of ["P-256", "prime256v1", "secp384r1", "P-384"]) {
    t(`generate ec ${curve}`, () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: curve });
      const sig = crypto.sign("sha256", msg, privateKey);
      return [privateKey.asymmetricKeyType, JSON.stringify(privateKey.asymmetricKeyDetails), crypto.verify("sha256", msg, publicKey, sig)];
    });
  }
  t("generate ed25519", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return [publicKey.asymmetricKeyType, JSON.stringify(privateKey.asymmetricKeyDetails), crypto.verify(null, msg, publicKey, crypto.sign(null, msg, privateKey))];
  });
  t("generate with encodings", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    return [typeof publicKey, typeof privateKey, (publicKey as string).split("\n")[0], (privateKey as string).split("\n")[0], crypto.verify("sha256", msg, publicKey, crypto.sign("sha256", msg, privateKey))];
  });
  t("generate der", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
    return [Buffer.isBuffer(publicKey), (publicKey as Buffer).length, Buffer.isBuffer(privateKey), (privateKey as Buffer).length];
  });
  t("generate bad type", () => crypto.generateKeyPairSync("nope" as never, {} as never));
  t("getCiphers", () => {
    const list = crypto.getCiphers();
    return ["aes-128-cbc", "aes-256-gcm", "aes-192-ctr", "aes-128-ecb"].map((c) => list.includes(c));
  });
  return lines;
}

/** ChaCha20-Poly1305 against RFC 8439 section 2.8.2 (native Bun has none of it, so it isn't in `run`). */
export function chacha(crypto: Crypto): string {
  if (!crypto.getCiphers().includes("chacha20-poly1305")) return "chacha20: skipped";
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
  const nonce = Buffer.from("070000004041424344454647", "hex");
  const aad = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
  const text = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const c = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: text.length });
  const ct = Buffer.concat([c.update(text.subarray(0, 50)), c.update(text.subarray(50)), c.final()]);
  const tag = c.getAuthTag();
  const d = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: text.length });
  d.setAuthTag(tag);
  const back = Buffer.concat([d.update(ct), d.final()]);
  const bad = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  bad.setAAD(aad);
  bad.setAuthTag(Buffer.alloc(16));
  bad.update(ct);
  let rejected = false;
  try {
    bad.final();
  } catch {
    rejected = true;
  }
  const ok = ct.toString("hex").startsWith("d31a8d34648e60db7b86afbc53ef7ec2") && tag.toString("hex") === "1ae10b594f09e26a7e902ecbd0600691" && back.equals(text) && rejected;
  return `chacha20: ${ok ? "ok" : "FAILED " + ct.toString("hex") + " " + tag.toString("hex")}`;
}
