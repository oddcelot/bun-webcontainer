//! Asymmetric keys and what they do. Keys cross the ABI in one canonical form: PKCS#8 DER for a private key, SPKI DER
//! for a public one (the host keeps those bytes in its KeyObject, and converts to PEM, PKCS#1, SEC1 or JWK on export).
//!
//! Ops: 20 import(der, want_private, type) -> key; 21 export(key, private, type) -> der; 22 jwk(key, private) -> pairs;
//! 23 from_jwk(pairs) -> key; 24 generate(type, param, exponent) -> key; 30 sign; 31 verify; 40 encrypt; 41 decrypt.
//! A `key` is the fields [private (0|1), type ("rsa"|"ec"|"ed25519"), canonical DER, curve, modulus bits (u32 le),
//! public exponent].

use digest::Digest;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey, EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::pkcs8::spki::SubjectPublicKeyInfoRef;
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, ObjectIdentifier, PrivateKeyInfo};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{BigUint, Oaep, Pkcs1v15Encrypt, Pkcs1v15Sign, Pss, RsaPrivateKey, RsaPublicKey};

use crate::{Args, Error, HostRng, Out, Result, err};

const RSA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");
const EC: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");
const P256_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
const P384_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.34");
const ED25519: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.112");

#[derive(Clone, Copy, PartialEq)]
enum Curve {
    P256,
    P384,
}

impl Curve {
    fn from_oid(oid: ObjectIdentifier) -> Option<Curve> {
        if oid == P256_OID {
            Some(Curve::P256)
        } else if oid == P384_OID {
            Some(Curve::P384)
        } else {
            None
        }
    }

    /// OpenSSL's name, which `asymmetricKeyDetails.namedCurve` reports.
    fn name(self) -> &'static str {
        match self {
            Curve::P256 => "prime256v1",
            Curve::P384 => "secp384r1",
        }
    }

    fn jwk(self) -> &'static str {
        match self {
            Curve::P256 => "P-256",
            Curve::P384 => "P-384",
        }
    }

    fn from_jwk(name: &str) -> Option<Curve> {
        match name {
            "P-256" | "prime256v1" | "secp256r1" => Some(Curve::P256),
            "P-384" | "secp384r1" => Some(Curve::P384),
            _ => None,
        }
    }
}

/// Runs the body with `$m` bound to the curve's crate (p256 or p384).
macro_rules! on_curve {
    ($curve:expr, $m:ident => $body:expr) => {
        match $curve {
            Curve::P256 => {
                use p256 as $m;
                $body
            }
            Curve::P384 => {
                use p384 as $m;
                $body
            }
        }
    };
}

/// Runs the body with `$D` bound to the digest type named.
macro_rules! on_hash {
    ($name:expr, $D:ident => $body:expr) => {
        match $name {
            "sha1" => {
                type $D = sha1::Sha1;
                $body
            }
            "sha224" => {
                type $D = sha2::Sha224;
                $body
            }
            "sha256" => {
                type $D = sha2::Sha256;
                $body
            }
            "sha384" => {
                type $D = sha2::Sha384;
                $body
            }
            "sha512" => {
                type $D = sha2::Sha512;
                $body
            }
            _ => err("ERR_CRYPTO_INVALID_DIGEST", format!("Invalid digest: {}", $name)),
        }
    };
}

enum Private {
    Rsa(RsaPrivateKey),
    Ec(Curve, Vec<u8>),
    Ed(SigningKey),
}

enum Public {
    Rsa(RsaPublicKey),
    Ec(Curve, Vec<u8>),
    Ed(VerifyingKey),
}

fn invalid<T>(what: &str) -> Result<T> {
    err("ERR_OSSL_UNSUPPORTED", format!("error:1E08010C:DECODER routines::{what}"))
}

fn ec_curve(oid: Option<ObjectIdentifier>) -> Result<Curve> {
    match oid.and_then(Curve::from_oid) {
        Some(c) => Ok(c),
        None => err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name"),
    }
}

fn load_private(der: &[u8]) -> Result<Private> {
    let info = PrivateKeyInfo::try_from(der).or_else(|_| invalid("unsupported"))?;
    let oid = info.algorithm.oid;
    if oid == RSA {
        Ok(Private::Rsa(RsaPrivateKey::from_pkcs8_der(der).or_else(|_| invalid("unsupported"))?))
    } else if oid == EC {
        let c = ec_curve(info.algorithm.parameters_oid().ok())?;
        let ok = on_curve!(c, m => m::SecretKey::from_pkcs8_der(der).is_ok());
        if !ok {
            return invalid("unsupported");
        }
        Ok(Private::Ec(c, der.to_vec()))
    } else if oid == ED25519 {
        Ok(Private::Ed(SigningKey::from_pkcs8_der(der).or_else(|_| invalid("unsupported"))?))
    } else {
        invalid("unsupported")
    }
}

fn load_public(der: &[u8]) -> Result<Public> {
    let info = SubjectPublicKeyInfoRef::try_from(der).or_else(|_| invalid("unsupported"))?;
    let oid = info.algorithm.oid;
    if oid == RSA {
        Ok(Public::Rsa(RsaPublicKey::from_public_key_der(der).or_else(|_| invalid("unsupported"))?))
    } else if oid == EC {
        let c = ec_curve(info.algorithm.parameters_oid().ok())?;
        let ok = on_curve!(c, m => m::PublicKey::from_public_key_der(der).is_ok());
        if !ok {
            return invalid("unsupported");
        }
        Ok(Public::Ec(c, der.to_vec()))
    } else if oid == ED25519 {
        Ok(Public::Ed(VerifyingKey::from_public_key_der(der).or_else(|_| invalid("unsupported"))?))
    } else {
        invalid("unsupported")
    }
}

fn der_err(e: impl core::fmt::Display) -> Error {
    Error { code: "ERR_OSSL_UNSUPPORTED", message: format!("error:1E08010C:DECODER routines::{e}") }
}

fn private_der(k: &Private) -> Result<Vec<u8>> {
    Ok(match k {
        Private::Rsa(k) => k.to_pkcs8_der().map_err(der_err)?.as_bytes().to_vec(),
        Private::Ec(_, d) => d.clone(),
        // OpenSSL's PKCS#8 for Ed25519 is the version 0 form (no public key), which the crate does not write.
        Private::Ed(k) => {
            let mut d = vec![0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
            d.extend_from_slice(&k.to_bytes());
            d
        }
    })
}

/// One DER element (lengths up to 65535).
fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut o = vec![tag];
    match content.len() {
        n if n < 0x80 => o.push(n as u8),
        n if n < 0x100 => o.extend([0x81, n as u8]),
        n => o.extend([0x82, (n >> 8) as u8, n as u8]),
    }
    o.extend_from_slice(content);
    o
}

/// OpenSSL's SEC1 ECPrivateKey: the scalar, the curve's OID and the public point (the crate's leaves out the OID).
fn sec1_der(c: Curve, pkcs8: &[u8]) -> Result<Vec<u8>> {
    let (scalar, point) = on_curve!(c, m => {
        use m::elliptic_curve::sec1::ToEncodedPoint;
        let k = m::SecretKey::from_pkcs8_der(pkcs8).map_err(der_err)?;
        (k.to_bytes().to_vec(), k.public_key().to_encoded_point(false).as_bytes().to_vec())
    });
    let oid: &[u8] = match c {
        Curve::P256 => &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
        Curve::P384 => &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22],
    };
    let mut bits = vec![0u8];
    bits.extend_from_slice(&point);
    let mut body = tlv(0x02, &[1]);
    body.extend(tlv(0x04, &scalar));
    body.extend(tlv(0xa0, oid));
    body.extend(tlv(0xa1, &tlv(0x03, &bits)));
    Ok(tlv(0x30, &body))
}

fn public_der(k: &Public) -> Result<Vec<u8>> {
    Ok(match k {
        Public::Rsa(k) => k.to_public_key_der().map_err(der_err)?.as_bytes().to_vec(),
        Public::Ec(_, d) => d.clone(),
        Public::Ed(k) => k.to_public_key_der().map_err(der_err)?.as_bytes().to_vec(),
    })
}

fn derive_public(k: &Private) -> Result<Public> {
    Ok(match k {
        Private::Rsa(k) => Public::Rsa(k.to_public_key()),
        Private::Ec(c, d) => {
            let spki = on_curve!(*c, m => m::SecretKey::from_pkcs8_der(d).map_err(der_err)?.public_key().to_public_key_der().map_err(der_err)?.as_bytes().to_vec());
            Public::Ec(*c, spki)
        }
        Private::Ed(k) => Public::Ed(k.verifying_key()),
    })
}

fn put_key(out: &mut Out, private: bool, der: &[u8]) -> Result<()> {
    let (ty, curve, bits, e) = if private {
        match load_private(der)? {
            Private::Rsa(k) => ("rsa", "", k.n().bits() as u32, k.e().to_bytes_be()),
            Private::Ec(c, _) => ("ec", c.name(), 0, Vec::new()),
            Private::Ed(_) => ("ed25519", "", 0, Vec::new()),
        }
    } else {
        match load_public(der)? {
            Public::Rsa(k) => ("rsa", "", k.n().bits() as u32, k.e().to_bytes_be()),
            Public::Ec(c, _) => ("ec", c.name(), 0, Vec::new()),
            Public::Ed(_) => ("ed25519", "", 0, Vec::new()),
        }
    };
    out.put(&[private as u8]).put(ty.as_bytes()).put(der).put(curve.as_bytes()).put(&bits.to_le_bytes()).put(&e);
    Ok(())
}

fn import(der: &[u8], want_private: bool, ty: &str) -> Result<Out> {
    let mut out = Out::default();
    let private: Option<Private> = match ty {
        "pkcs8" => match load_private(der) {
            Ok(k) => Some(k),
            Err(e) if want_private => return Err(e),
            Err(_) => None,
        },
        "pkcs1" | "pkcs1-private" => match RsaPrivateKey::from_pkcs1_der(der) {
            Ok(k) => Some(Private::Rsa(k)),
            Err(_) if ty == "pkcs1" && !want_private => None,
            Err(_) => return invalid("unsupported"),
        },
        "sec1" => {
            let mut found = None;
            for c in [Curve::P256, Curve::P384] {
                let pk8 = on_curve!(c, m => m::SecretKey::from_sec1_der(der).ok().and_then(|k| k.to_pkcs8_der().ok()).map(|d| d.as_bytes().to_vec()));
                if let Some(d) = pk8 {
                    found = Some(Private::Ec(c, d));
                    break;
                }
            }
            match found {
                Some(k) => Some(k),
                None => return invalid("unsupported"),
            }
        }
        "spki" | "pkcs1-public" => None,
        _ => return invalid("unsupported"),
    };
    if let Some(k) = private {
        if want_private {
            put_key(&mut out, true, &private_der(&k)?)?;
        } else {
            put_key(&mut out, false, &public_der(&derive_public(&k)?)?)?;
        }
        return Ok(out);
    }
    if want_private {
        return invalid("unsupported");
    }
    let public = match ty {
        "pkcs1" | "pkcs1-public" => Public::Rsa(RsaPublicKey::from_pkcs1_der(der).or_else(|_| invalid("unsupported"))?),
        "spki" => load_public(der)?,
        "pkcs8" => derive_public(&load_private(der)?)?,
        _ => return invalid("unsupported"),
    };
    put_key(&mut out, false, &public_der(&public)?)?;
    Ok(out)
}

fn incompatible<T>(ty: &str) -> Result<T> {
    let only = if ty == "sec1" { "EC" } else { "RSA" };
    err("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", format!("The selected key encoding {ty} can only be used for {only} keys."))
}

fn export(der: &[u8], private: bool, ty: &str) -> Result<Vec<u8>> {
    if private {
        let k = load_private(der)?;
        return match (ty, &k) {
            ("pkcs8", _) => Ok(der.to_vec()),
            ("pkcs1", Private::Rsa(k)) => Ok(k.to_pkcs1_der().map_err(der_err)?.as_bytes().to_vec()),
            ("sec1", Private::Ec(c, d)) => sec1_der(*c, d),
            _ => incompatible(ty),
        };
    }
    let k = load_public(der)?;
    match (ty, &k) {
        ("spki", _) => Ok(der.to_vec()),
        ("pkcs1", Public::Rsa(k)) => Ok(k.to_pkcs1_der().map_err(der_err)?.as_bytes().to_vec()),
        _ => incompatible(ty),
    }
}

fn be(n: &BigUint) -> Vec<u8> {
    n.to_bytes_be()
}

fn jwk(der: &[u8], private: bool) -> Result<Out> {
    let mut out = Out::default();
    let mut pair = |name: &str, v: &[u8]| {
        out.put(name.as_bytes()).put(v);
    };
    let public = if private { derive_public(&load_private(der)?)? } else { load_public(der)? };
    match &public {
        Public::Rsa(p) => {
            pair("kty", b"RSA");
            pair("n", &be(p.n()));
            pair("e", &be(p.e()));
            if private && let Private::Rsa(k) = load_private(der)? {
                let one = BigUint::from(1u8);
                let (pp, q) = (&k.primes()[0], &k.primes()[1]);
                pair("d", &be(k.d()));
                pair("p", &be(pp));
                pair("q", &be(q));
                pair("dp", &be(&(k.d() % (pp - &one))));
                pair("dq", &be(&(k.d() % (q - &one))));
                pair("qi", &be(&k.crt_coefficient().ok_or(()).or_else(|_| invalid("unsupported"))?));
            }
        }
        Public::Ec(c, d) => {
            pair("kty", b"EC");
            pair("crv", c.jwk().as_bytes());
            let (x, y) = on_curve!(*c, m => {
                use m::elliptic_curve::sec1::ToEncodedPoint;
                let pt = m::PublicKey::from_public_key_der(d).map_err(der_err)?.to_encoded_point(false);
                (pt.x().map(|x| x.to_vec()).unwrap_or_default(), pt.y().map(|y| y.to_vec()).unwrap_or_default())
            });
            pair("x", &x);
            pair("y", &y);
            if private && let Private::Ec(c, d) = load_private(der)? {
                let s = on_curve!(c, m => m::SecretKey::from_pkcs8_der(&d).map_err(der_err)?.to_bytes().to_vec());
                pair("d", &s);
            }
        }
        Public::Ed(v) => {
            pair("kty", b"OKP");
            pair("crv", b"Ed25519");
            pair("x", v.as_bytes());
            if private && let Private::Ed(k) = load_private(der)? {
                pair("d", &k.to_bytes());
            }
        }
    }
    Ok(out)
}

fn bad_jwk() -> Error {
    Error { code: "ERR_CRYPTO_INVALID_JWK", message: "Invalid JWK data".into() }
}

fn from_jwk(a: &Args) -> Result<Out> {
    let field = |name: &str| -> Option<&[u8]> {
        (0..a.len()).step_by(2).find(|&i| a.get(i) == name.as_bytes()).map(|i| a.get(i + 1))
    };
    let bad = || -> Result<Out> { Err(bad_jwk()) };
    let mut out = Out::default();
    let kty = field("kty").unwrap_or(b"");
    match kty {
        b"RSA" => {
            let (Some(n), Some(e)) = (field("n"), field("e")) else { return bad() };
            let (n, e) = (BigUint::from_bytes_be(n), BigUint::from_bytes_be(e));
            if let Some(d) = field("d") {
                let (Some(p), Some(q)) = (field("p"), field("q")) else { return bad() };
                let k = RsaPrivateKey::from_components(n, e, BigUint::from_bytes_be(d), vec![BigUint::from_bytes_be(p), BigUint::from_bytes_be(q)]).map_err(|_| bad_jwk())?;
                put_key(&mut out, true, &private_der(&Private::Rsa(k))?)?;
            } else {
                let k = RsaPublicKey::new(n, e).map_err(|_| bad_jwk())?;
                put_key(&mut out, false, &public_der(&Public::Rsa(k))?)?;
            }
        }
        b"EC" => {
            let Some(c) = field("crv").and_then(|c| core::str::from_utf8(c).ok()).and_then(Curve::from_jwk) else {
                return err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
            };
            if let Some(d) = field("d") {
                let der = on_curve!(c, m => m::SecretKey::from_slice(d).ok().and_then(|k| k.to_pkcs8_der().ok()).map(|d| d.as_bytes().to_vec()));
                let Some(der) = der else { return bad() };
                put_key(&mut out, true, &der)?;
            } else {
                let (Some(x), Some(y)) = (field("x"), field("y")) else { return bad() };
                let mut sec1 = vec![4u8];
                sec1.extend_from_slice(x);
                sec1.extend_from_slice(y);
                let der = on_curve!(c, m => m::PublicKey::from_sec1_bytes(&sec1).ok().and_then(|k| k.to_public_key_der().ok()).map(|d| d.as_bytes().to_vec()));
                let Some(der) = der else { return bad() };
                put_key(&mut out, false, &der)?;
            }
        }
        b"OKP" => {
            if field("crv") != Some(b"Ed25519") {
                return err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
            }
            if let Some(d) = field("d") {
                let Ok(seed) = <[u8; 32]>::try_from(d) else { return bad() };
                put_key(&mut out, true, &private_der(&Private::Ed(SigningKey::from_bytes(&seed)))?)?;
            } else {
                let Some(x) = field("x").and_then(|x| <[u8; 32]>::try_from(x).ok()) else { return bad() };
                let Ok(k) = VerifyingKey::from_bytes(&x) else { return bad() };
                put_key(&mut out, false, &public_der(&Public::Ed(k))?)?;
            }
        }
        _ => return err("ERR_CRYPTO_INVALID_JWK", "Unsupported JWK Key Type."),
    }
    Ok(out)
}

fn generate(a: &Args) -> Result<Out> {
    let mut out = Out::default();
    match a.str(0) {
        "rsa" => {
            let bits = u32::from_le_bytes(a.get(1).try_into().unwrap_or([0; 4])) as usize;
            let e = BigUint::from_bytes_be(a.get(2));
            let k = RsaPrivateKey::new_with_exp(&mut HostRng, bits, &e).map_err(|_| Error { code: "ERR_OSSL_RSA_KEY_SIZE_TOO_SMALL", message: "error:0400006E:RSA routines:OPENSSL_internal:KEY_SIZE_TOO_SMALL".into() })?;
            put_key(&mut out, true, &private_der(&Private::Rsa(k))?)?;
        }
        "ec" => {
            let Some(c) = Curve::from_jwk(a.str(1)) else { return err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name") };
            let der = on_curve!(c, m => m::SecretKey::random(&mut HostRng).to_pkcs8_der().map_err(der_err)?.as_bytes().to_vec());
            put_key(&mut out, true, &der)?;
        }
        "ed25519" => put_key(&mut out, true, &private_der(&Private::Ed(SigningKey::generate(&mut HostRng)))?)?,
        _ => return err("ERR_INVALID_ARG_VALUE", "The argument 'type' must be a supported key type."),
    }
    Ok(out)
}

fn hash(name: &str, data: &[u8]) -> Result<Vec<u8>> {
    on_hash!(name, D => Ok(D::digest(data).to_vec()))
}

/// The PSS salt length Node means by `saltLength` (an `i32`; -1 is the digest size, -2 the most that fits or any on verify).
fn pss_salt(salt: i32, h_len: usize, bits: usize, verify: bool) -> Vec<usize> {
    let em_len = (bits - 1).div_ceil(8);
    let max = em_len.saturating_sub(h_len + 2);
    match salt {
        -1 => vec![h_len],
        -2 if !verify => vec![max],
        -2 => {
            // Auto: the usual lengths first, then every other.
            let mut v = vec![h_len, max, 0];
            v.extend((1..max).filter(|&n| n != h_len));
            v
        }
        n => vec![n.max(0) as usize],
    }
}

fn int(b: &[u8]) -> i32 {
    core::str::from_utf8(b).ok().and_then(|s| s.parse().ok()).unwrap_or(-2)
}

/// sign(key, digest, padding, salt length, data, p1363)
fn sign(a: &Args) -> Result<Vec<u8>> {
    let (digest, padding, data, p1363) = (a.str(1), a.str(2), a.get(4), a.byte(5) != 0);
    match load_private(a.get(0))? {
        Private::Ed(k) => Ok(k.sign(data).to_bytes().to_vec()),
        Private::Rsa(k) => on_hash!(digest, D => {
            let h = D::digest(data);
            let bad = |_| Error { code: "ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", message: "error:04000069:RSA routines:OPENSSL_internal:DIGEST_TOO_BIG_FOR_RSA_KEY".into() };
            if padding == "pss" {
                let salt = pss_salt(int(a.get(3)), h.len(), k.n().bits(), false)[0];
                k.sign_with_rng(&mut HostRng, Pss::new_with_salt::<D>(salt), &h).map_err(bad)
            } else {
                k.sign_with_rng(&mut HostRng, Pkcs1v15Sign::new::<D>(), &h).map_err(bad)
            }
        }),
        Private::Ec(c, der) => {
            let h = hash(digest, data)?;
            on_curve!(c, m => {
                use m::ecdsa::signature::hazmat::PrehashSigner;
                let sk = m::ecdsa::SigningKey::from_pkcs8_der(&der).map_err(der_err)?;
                let sig: m::ecdsa::Signature = sk.sign_prehash(&h).map_err(|_| Error { code: "ERR_CRYPTO_OPERATION_FAILED", message: "Failed to sign".into() })?;
                Ok(if p1363 { sig.to_bytes().to_vec() } else { sig.to_der().as_bytes().to_vec() })
            })
        }
    }
}

/// verify(key, digest, padding, salt length, data, signature, p1363) -> 0 | 1
fn verify(a: &Args) -> Result<bool> {
    let (digest, padding, data, sig, p1363) = (a.str(1), a.str(2), a.get(4), a.get(5), a.byte(6) != 0);
    match load_public(a.get(0))? {
        Public::Ed(k) => Ok(ed25519_dalek::Signature::from_slice(sig).map(|s| k.verify(data, &s).is_ok()).unwrap_or(false)),
        Public::Rsa(k) => on_hash!(digest, D => {
            let h = D::digest(data);
            Ok(if padding == "pss" {
                pss_salt(int(a.get(3)), h.len(), k.n().bits(), true).into_iter().any(|s| k.verify(Pss::new_with_salt::<D>(s), &h, sig).is_ok())
            } else {
                k.verify(Pkcs1v15Sign::new::<D>(), &h, sig).is_ok()
            })
        }),
        Public::Ec(c, der) => {
            let h = hash(digest, data)?;
            on_curve!(c, m => {
                use m::ecdsa::signature::hazmat::PrehashVerifier;
                let vk = m::ecdsa::VerifyingKey::from_public_key_der(&der).map_err(der_err)?;
                let sig = if p1363 { m::ecdsa::Signature::from_slice(sig) } else { m::ecdsa::Signature::from_der(sig) };
                Ok(sig.map(|s| vk.verify_prehash(&h, &s).is_ok()).unwrap_or(false))
            })
        }
    }
}

fn oaep_error() -> Error {
    Error { code: "ERR_OSSL_RSA_OAEP_DECODING_ERROR", message: "error:04000085:RSA routines:OPENSSL_internal:OAEP_DECODING_ERROR".into() }
}

/// encrypt(public key, padding, oaep hash, oaep label, data) / decrypt(private key, ...)
fn crypt(a: &Args, encrypt: bool) -> Result<Vec<u8>> {
    let (padding, hash, label, data) = (a.str(1), a.str(2), a.get(3), a.get(4));
    let label = core::str::from_utf8(label).or_else(|_| err("ERR_INVALID_ARG_VALUE", "oaepLabel must be valid UTF-8"))?.to_string();
    let too_big = |_| Error { code: "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE", message: "error:04000072:RSA routines:OPENSSL_internal:DATA_TOO_LARGE_FOR_KEY_SIZE".into() };
    if encrypt {
        let Public::Rsa(k) = load_public(a.get(0))? else { return err("ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "operation not supported for this keytype") };
        return match padding {
            "oaep" => on_hash!(hash, D => if label.is_empty() { k.encrypt(&mut HostRng, Oaep::new::<D>(), data) } else { k.encrypt(&mut HostRng, Oaep::new_with_label::<D, _>(label), data) }.map_err(too_big)),
            _ => k.encrypt(&mut HostRng, Pkcs1v15Encrypt, data).map_err(too_big),
        };
    }
    let Private::Rsa(k) = load_private(a.get(0))? else { return err("ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "operation not supported for this keytype") };
    match padding {
        "oaep" => on_hash!(hash, D => if label.is_empty() { k.decrypt_blinded(&mut HostRng, Oaep::new::<D>(), data) } else { k.decrypt_blinded(&mut HostRng, Oaep::new_with_label::<D, _>(label), data) }.map_err(|_| oaep_error())),
        _ => k.decrypt_blinded(&mut HostRng, Pkcs1v15Encrypt, data).map_err(|_| Error { code: "ERR_OSSL_RSA_PKCS_DECODING_ERROR", message: "error:04000079:RSA routines:OPENSSL_internal:PKCS_DECODING_ERROR".into() }),
    }
}

pub fn call(op: u32, a: &Args) -> Result<Out> {
    let mut out = Out::default();
    match op {
        20 => return import(a.get(0), a.byte(1) != 0, a.str(2)),
        21 => {
            out.put(&export(a.get(0), a.byte(1) != 0, a.str(2))?);
        }
        22 => return jwk(a.get(0), a.byte(1) != 0),
        23 => return from_jwk(a),
        24 => return generate(a),
        30 => {
            out.put(&sign(a)?);
        }
        31 => {
            out.put(&[verify(a)? as u8]);
        }
        40 | 41 => {
            out.put(&crypt(a, op == 40)?);
        }
        _ => return err("ERR_INTERNAL", "unknown op"),
    }
    Ok(out)
}
