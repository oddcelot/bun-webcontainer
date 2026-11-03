//! `Bun.password`: argon2 and bcrypt through the crates Bun uses (`rust-argon2`, vendored in bun/vendor with Bun's
//! patch, and `bcrypt`), following bun/src/runtime/crypto/pwhash.rs. bcrypt's string form (`$2b$` and the salt
//! handling of the crate's `_hash_password`/`split_hash`) is redone here over the crate's `bcrypt()` core, as the
//! crate's own needs `getrandom`. The host passes the random salt (no `getrandom`
//! here) and does what PasswordObject.rs does around these calls (argument checks, picking the algorithm from the
//! hash, SHA-512 of a bcrypt password over 72 bytes). Errors are Bun's error names (`InvalidEncoding`, …).

pub const ARGON2D: u32 = 1;
pub const ARGON2I: u32 = 2;
pub const ARGON2ID: u32 = 3;
pub const BCRYPT: u32 = 4;

type Error = &'static str;

const MAX_VERIFY_TIME_COST: u32 = 1 << 16;
const MAX_VERIFY_MEMORY_COST: u32 = 1 << 22;
const MAX_VERIFY_PARALLELISM: u32 = 64;

fn argon2_error(e: argon2::Error) -> Error {
    use argon2::Error as E;
    match e {
        E::DecodingFail | E::IncorrectType | E::IncorrectVersion => "InvalidEncoding",
        E::MemoryAllocationFailed => "OutOfMemory",
        _ => "WeakParameters",
    }
}

/// The 23-byte bcrypt digest, as the crate's `_hash_password` (silently truncating, as Bun asks): NUL-terminated and
/// cut at 72 bytes.
fn bcrypt_digest(password: &[u8], cost: u32, salt: [u8; 16]) -> Result<[u8; 23], Error> {
    if !(4..=31).contains(&cost) {
        return Err("WeakParameters");
    }
    let mut buf = [0u8; 72];
    let n = password.len().min(72);
    buf[..n].copy_from_slice(&password[..n]);
    let out = bcrypt::bcrypt(cost, salt, &buf[..(n + 1).min(72)]);
    Ok(out[..23].try_into().expect("24-byte output"))
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// The PHC string for `password`: 32-byte `salt`, 32-byte tag, version 0x13, one lane, as Bun's `str_hash`.
/// bcrypt (`algorithm` 4) takes a 16-byte salt and `cost` as its rounds and gives the `$2b$` form.
pub fn hash(password: &[u8], salt: &[u8], algorithm: u32, memory_cost: u32, time_cost: u32) -> Result<Vec<u8>, Error> {
    if algorithm == BCRYPT {
        use base64::Engine as _;
        let salt: [u8; 16] = salt.try_into().map_err(|_| "InvalidEncoding")?;
        let digest = bcrypt_digest(password, memory_cost, salt)?;
        let mut out = format!("$2b${memory_cost:02}$").into_bytes();
        let mut enc = [0u8; 31];
        let n = bcrypt::BASE_64.encode_slice(salt, &mut enc).map_err(|_| "InvalidEncoding")?;
        out.extend_from_slice(&enc[..n]);
        let n = bcrypt::BASE_64.encode_slice(digest, &mut enc).map_err(|_| "InvalidEncoding")?;
        out.extend_from_slice(&enc[..n]);
        return Ok(out);
    }
    let variant = match algorithm {
        ARGON2D => argon2::Variant::Argon2d,
        ARGON2I => argon2::Variant::Argon2i,
        _ => argon2::Variant::Argon2id,
    };
    let config = argon2::Config {
        ad: &[],
        secret: &[],
        hash_length: 32,
        lanes: 1,
        mem_cost: memory_cost,
        time_cost,
        thread_mode: argon2::ThreadMode::Sequential,
        variant,
        version: argon2::Version::Version13,
    };
    argon2::hash_encoded(password, salt, &config).map(String::into_bytes).map_err(argon2_error)
}

/// Whether `password` matches `encoded`, checked as `algorithm` (argon2 for 1-3, bcrypt for 4).
pub fn verify(password: &[u8], encoded: &[u8], algorithm: u32) -> Result<bool, Error> {
    if !encoded.is_ascii() {
        return Err("InvalidEncoding");
    }
    let encoded = core::str::from_utf8(encoded).map_err(|_| "InvalidEncoding")?;
    if algorithm == BCRYPT { bcrypt_verify(password, encoded) } else { argon2_verify(password, encoded) }
}

fn argon2_verify(password: &[u8], encoded: &str) -> Result<bool, Error> {
    // As pwhash.rs: only version 0x13; a missing `v=` means 0x13 (rust-argon2 would take 0x10), and the costs are capped.
    let normalised = (|| {
        let after = encoded.strip_prefix('$')?;
        let alg_end = 1 + after.find('$')?;
        let rest = &encoded[alg_end + 1..];
        Some(match rest.strip_prefix("v=") {
            Some(v) => {
                if &v[..v.find('$').unwrap_or(v.len())] != "19" {
                    return Some(Err("InvalidEncoding"));
                }
                Ok(encoded.to_owned())
            }
            None => Ok(format!("{}v=19${rest}", &encoded[..=alg_end])),
        })
    })()
    .unwrap_or_else(|| Ok(encoded.to_owned()))?;
    if let Some(after) = normalised.strip_prefix('$')
        && let Some(sep) = after.find('$')
    {
        let mut rest = &after[sep + 1..];
        if let Some(v) = rest.strip_prefix("v=") {
            rest = v.find('$').map_or("", |end| &v[end + 1..]);
        }
        for pair in rest[..rest.find('$').unwrap_or(rest.len())].split(',') {
            let Some((key, value)) = pair.split_once('=') else { continue };
            let limit = match key {
                "m" => MAX_VERIFY_MEMORY_COST,
                "t" => MAX_VERIFY_TIME_COST,
                "p" => MAX_VERIFY_PARALLELISM,
                _ => continue,
            };
            let value: u32 = value.parse().map_err(|_| "InvalidEncoding")?;
            if value > limit {
                return Err("WeakParameters");
            }
        }
    }
    argon2::verify_encoded(&normalised, password).map_err(argon2_error)
}

fn bcrypt_verify(password: &[u8], encoded: &str) -> Result<bool, Error> {
    use base64::Engine as _;
    if encoded.starts_with("$2") {
        // The crate's `split_hash`: any of 2a/2b/2x/2y, the version itself isn't used.
        let b = encoded.as_bytes();
        if b.len() != 60 || b[3] != b'$' || b[6] != b'$' || !matches!(&encoded[1..3], "2a" | "2b" | "2x" | "2y") {
            return Err("InvalidEncoding");
        }
        let cost: u32 = encoded[4..6].parse().map_err(|_| "InvalidEncoding")?;
        let (mut salt, mut expected) = ([0u8; 16], [0u8; 23]);
        bcrypt::BASE_64.decode_slice(&encoded[7..29], &mut salt).map_err(|_| "InvalidEncoding")?;
        bcrypt::BASE_64.decode_slice(&encoded[29..], &mut expected).map_err(|_| "InvalidEncoding")?;
        return Ok(same(&bcrypt_digest(password, cost, salt)?, &expected));
    }
    // The PHC form, `$bcrypt$r=N$<salt>$<hash>` (standard base64, no padding), as pwhash.rs `verify_phc`.
    let rest = encoded.strip_prefix('$').ok_or("InvalidEncoding")?;
    let (alg, rest) = rest.split_once('$').ok_or("InvalidEncoding")?;
    if alg != "bcrypt" {
        return Ok(false);
    }
    let (params, rest) = rest.split_once('$').ok_or("InvalidEncoding")?;
    let rounds: u8 = params.strip_prefix("r=").and_then(|r| r.parse().ok()).ok_or("InvalidEncoding")?;
    if rounds > 63 {
        return Err("InvalidEncoding");
    }
    let (salt_b64, digest_b64) = rest.split_once('$').ok_or("InvalidEncoding")?;
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD;
    let (mut salt, mut expected) = ([0u8; 16], [0u8; 23]);
    let exact = |s: &str, out: &mut [u8]| matches!(b64.decode_slice(s, out), Ok(n) if n == out.len()) && b64.decode_slice(s, &mut [0u8; 64][..]).ok() == Some(out.len());
    if !exact(salt_b64, &mut salt) || !exact(digest_b64, &mut expected) {
        return Err("InvalidEncoding");
    }
    Ok(same(&bcrypt_digest(password, u32::from(rounds), salt)?, &expected))
}
