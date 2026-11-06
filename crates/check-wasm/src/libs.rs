//! TypeScript's `lib.*.d.ts` files, as `bun check` has them built in (see build.rs for the format). Each is inflated
//! when the checker first reads it.

use bun_sema_driver::host::BundledLibs;
use std::borrow::Cow;
use std::sync::OnceLock;

static BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/libs.bin"));

fn number(bytes: &[u8]) -> usize {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
}

/// Every file's name and deflated text, sorted by name.
fn files() -> &'static [(&'static [u8], &'static [u8])] {
    static FILES: OnceLock<Vec<(&'static [u8], &'static [u8])>> = OnceLock::new();
    FILES.get_or_init(|| {
        let count = number(BUNDLE);
        let (mut at, mut names) = (4, Vec::with_capacity(count));
        for _ in 0..count {
            let len = usize::from(BUNDLE[at]);
            names.push((&BUNDLE[at + 1..][..len], number(&BUNDLE[at + 1 + len..])));
            at += 1 + len + 4;
        }
        let mut files: Vec<_> = names
            .into_iter()
            .map(|(name, len)| {
                let text = &BUNDLE[at..][..len];
                at += len;
                (name, text)
            })
            .collect();
        files.sort_unstable_by_key(|(name, _)| *name);
        files
    })
}

fn deflated(name: &[u8]) -> Option<&'static [u8]> {
    let files = files();
    files.binary_search_by_key(&name, |(it, _)| it).ok().map(|i| files[i].1)
}

fn read(name: &[u8]) -> Option<Cow<'static, [u8]>> {
    miniz_oxide::inflate::decompress_to_vec(deflated(name)?).ok().map(Cow::Owned)
}

pub const BUNDLED: BundledLibs = BundledLibs { has: |name| deflated(name).is_some(), read };
