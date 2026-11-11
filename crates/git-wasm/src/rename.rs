// Rename detection as git does it (diffcore-rename.c, with diffcore-delta.c's similarity): a deleted file and an added
// one pair up when their blobs are the same, else when git's similarity score reaches 50%. `status`, `diff --cached`,
// `show` and the commit summary use it, as git does by default (`diff.renames`).
use crate::Ctx;
use gix::ObjectId;
use gix::bstr::BString;
use std::collections::HashMap;

/// git's `MAX_SCORE`: a score is a fraction of it.
pub const MAX_SCORE: u64 = 60000;
/// `-M50%`, git's default.
const MINIMUM_SCORE: u64 = 30000;
/// diffcore-rename.c's `NUM_CANDIDATE_PER_DST`.
const CANDIDATES_PER_DST: usize = 4;

pub struct Rename {
    pub old: BString,
    pub new: BString,
    pub score: u64,
}

impl Rename {
    /// `similarity index N%`, `(N%)`: diff.c `similarity_index`.
    pub fn percent(&self) -> u64 {
        self.score * 100 / MAX_SCORE
    }
}

type Side = (BString, (u32, ObjectId));

const fn is_regular(mode: u32) -> bool {
    mode & 0o170000 == 0o100000
}

fn basename(p: &[u8]) -> &[u8] {
    p.rsplit(|&b| b == b'/').next().unwrap_or(p)
}

/// diffcore-delta.c `hash_chars`: the bytes in spans ending at a newline or after 64 bytes, by span hash.
fn spans(data: &[u8], is_text: bool) -> HashMap<u32, u64> {
    const HASHBASE: u32 = 107927;
    let mut counts = HashMap::new();
    let (mut a1, mut a2, mut n) = (0u32, 0u32, 0u64);
    let mut i = 0;
    while i < data.len() {
        let c = data[i];
        i += 1;
        // Ignore CR in CRLF sequence if text
        if is_text && c == b'\r' && data.get(i) == Some(&b'\n') {
            continue;
        }
        let old1 = a1;
        a1 = (a1 << 7) ^ (a2 >> 25);
        a2 = (a2 << 7) ^ (old1 >> 25);
        a1 = a1.wrapping_add(u32::from(c));
        n += 1;
        if n < 64 && c != b'\n' {
            continue;
        }
        let hash = a1.wrapping_add(a2.wrapping_mul(0x61)) % HASHBASE;
        *counts.entry(hash).or_insert(0) += n;
        (a1, a2, n) = (0, 0, 0);
    }
    if n > 0 {
        let hash = a1.wrapping_add(a2.wrapping_mul(0x61)) % HASHBASE;
        *counts.entry(hash).or_insert(0) += n;
    }
    counts
}

fn is_binary(d: &[u8]) -> bool {
    d[..d.len().min(8000)].contains(&0)
}

struct Blob {
    size: u64,
    spans: Option<HashMap<u32, u64>>,
    data: Vec<u8>,
}

impl Blob {
    fn spans(&mut self) -> &HashMap<u32, u64> {
        let text = !is_binary(&self.data);
        self.spans.get_or_insert_with(|| spans(&self.data, text))
    }
}

/// diffcore-rename.c `estimate_similarity`: the bytes of `src` that `dst` keeps, as a fraction of the larger one.
fn similarity(src: &mut Blob, dst: &mut Blob) -> u64 {
    let (max, min) = (src.size.max(dst.size), src.size.min(dst.size));
    if max * (MAX_SCORE - MINIMUM_SCORE) < (max - min) * MAX_SCORE || dst.size == 0 {
        return 0;
    }
    let dst_spans = dst.spans().clone();
    let copied: u64 = src.spans().iter().map(|(h, &n)| n.min(dst_spans.get(h).copied().unwrap_or(0))).sum();
    copied * MAX_SCORE / max
}

/// Pairs `deleted` with `added` (both sorted by path): exact renames first, then by similarity, best first.
pub fn detect(ctx: &Ctx, deleted: &[Side], added: &[Side]) -> Result<Vec<Rename>, crate::Exit> {
    let mut renames = Vec::new();
    let (mut src_used, mut dst_used) = (vec![false; deleted.len()], vec![false; added.len()]);

    // Exact: the same blob. Of several sources, the one with the destination's basename, else the first.
    for (d, (dpath, (dmode, did))) in added.iter().enumerate() {
        if !is_regular(*dmode) {
            continue;
        }
        let candidates = (0..deleted.len()).filter(|&s| !src_used[s] && deleted[s].1.1 == *did && is_regular(deleted[s].1.0));
        let candidates: Vec<usize> = candidates.collect();
        let Some(&s) = candidates.iter().find(|&&s| basename(&deleted[s].0) == basename(dpath)).or(candidates.first()) else {
            continue;
        };
        (src_used[s], dst_used[d]) = (true, true);
        renames.push(Rename { old: deleted[s].0.clone(), new: dpath.clone(), score: MAX_SCORE });
    }

    // Inexact: each destination's best few sources, then the best scores first.
    let load = |id: ObjectId| -> Result<Blob, crate::Exit> {
        let data = ctx.repo.find_object(id)?.detach().data;
        Ok(Blob { size: data.len() as u64, spans: None, data })
    };
    let (srcs, dsts): (Vec<usize>, Vec<usize>) = (
        (0..deleted.len()).filter(|&s| !src_used[s] && is_regular(deleted[s].1.0)).collect(),
        (0..added.len()).filter(|&d| !dst_used[d] && is_regular(added[d].1.0)).collect(),
    );
    if srcs.is_empty() || dsts.is_empty() {
        return Ok(sorted(renames));
    }
    let mut src_blobs: HashMap<usize, Blob> = HashMap::new();
    for &s in &srcs {
        src_blobs.insert(s, load(deleted[s].1.1)?);
    }
    // (score, name_score, dst, src)
    let mut matrix: Vec<(u64, bool, usize, usize)> = Vec::new();
    for &d in &dsts {
        let mut dst = load(added[d].1.1)?;
        let mut best: Vec<(u64, bool, usize, usize)> = Vec::new();
        for &s in &srcs {
            let score = similarity(src_blobs.get_mut(&s).expect("loaded"), &mut dst);
            if score < MINIMUM_SCORE {
                continue;
            }
            best.push((score, basename(&deleted[s].0) == basename(&added[d].0), d, s));
        }
        best.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        best.truncate(CANDIDATES_PER_DST);
        matrix.extend(best);
    }
    matrix.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)));
    for (score, _, d, s) in matrix {
        if dst_used[d] || src_used[s] {
            continue;
        }
        (src_used[s], dst_used[d]) = (true, true);
        renames.push(Rename { old: deleted[s].0.clone(), new: added[d].0.clone(), score });
    }
    Ok(sorted(renames))
}

fn sorted(mut renames: Vec<Rename>) -> Vec<Rename> {
    renames.sort_by(|a, b| a.new.cmp(&b.new));
    renames
}

/// diff.c `pprint_rename`: `a => b`, or the common directories outside braces, `src/{a.ts => b.ts}`.
pub fn pprint(a: &str, b: &str) -> String {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut pfx = 0;
    let mut i = 0;
    while i < a.len() && i < b.len() && a[i] == b[i] {
        if a[i] == b'/' {
            pfx = i + 1;
        }
        i += 1;
    }
    // From the end (the terminators match); with a prefix, one step into it to see its slash.
    let adjust = usize::from(pfx > 0);
    let (mut oa, mut ob) = (a.len() as isize, b.len() as isize);
    let at = |s: &[u8], k: isize| if k as usize == s.len() { 0 } else { s[k as usize] };
    let mut sfx = 0usize;
    while oa >= pfx as isize - adjust as isize && ob >= pfx as isize - adjust as isize && oa >= 0 && ob >= 0 && at(a, oa) == at(b, ob) {
        if at(a, oa) == b'/' {
            sfx = a.len() - oa as usize;
        }
        oa -= 1;
        ob -= 1;
    }
    let a_mid = a.len().saturating_sub(pfx + sfx);
    let b_mid = b.len().saturating_sub(pfx + sfx);
    let s = |x: &[u8]| String::from_utf8_lossy(x).into_owned();
    if pfx + sfx > 0 {
        format!("{}{{{} => {}}}{}", s(&a[..pfx]), s(&a[pfx..pfx + a_mid]), s(&b[pfx..pfx + b_mid]), s(&a[a.len() - sfx..]))
    } else {
        format!("{} => {}", s(a), s(b))
    }
}
