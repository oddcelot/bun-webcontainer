//! `Bun__visibleWidthExcludeANSI_utf8` and `Bun__visibleWidthExcludeANSI_utf8IndexAtWidth`: the terminal column width
//! of UTF-8 text with ANSI escapes at zero width, which `Bun.markdown.ansi` (heading underlines, wrapping, table
//! columns) calls. A port of the UTF-8 paths of Bun's `src/jsc/bindings/stringWidth.cpp` (and the escape recognizer
//! `ANSI::consumeANSI<true>` in `ANSIHelpers.h`), without the SIMD fast paths (scalar equivalents) and the Latin-1/
//! UTF-16/JS parts, so the playground measures like native Bun.
//!
//! These paths are per codepoint (the C++ says: "no grapheme clustering — keeps the historical behavior of the
//! console.table / markdown renderer callers"), so the grapheme-break machinery of `stringWidth.cpp` is not used by
//! them and not ported. The classification tables are `stringWidthTables.h`, parsed by build.rs.

mod tables {
    include!(concat!(env!("OUT_DIR"), "/string_width_tables.rs"));
}

// ─────────────── codepoint classification (stringWidth.cpp: fusedClassify, widthFromFused) ───────────────

/// `fusedClassify`: the packed byte of a codepoint, through the 3-stage table.
fn fused_classify(cp: u32) -> u8 {
    let high = (cp >> 8) as usize;
    let low = (cp & 0xFF) as usize;
    let stage2_index = tables::STAGE1[high] as usize + low;
    tables::STAGE3[tables::STAGE2[stage2_index] as usize]
}

/// `visibleCodepointWidth(cp, ambiguousAsWide = false)` (= `widthFromFused`): bits 5-6 of the packed byte are the
/// width class (0 zero-width, 1 narrow, 2 wide, 3 East Asian Ambiguous, narrow here).
fn visible_codepoint_width(cp: u32) -> usize {
    let width = (fused_classify(cp) >> 5) & 0x3;
    if width == 3 { 1 } else { width as usize }
}

/// `visibleLatin1WidthScalar`, for ASCII bytes (the only ones the UTF-8 paths hand it): C0 controls and DEL are
/// zero-width. (The full Latin-1 rule also zeroes 0x80-0x9F and 0xAD.)
fn visible_latin1_width_scalar(c: u8) -> usize {
    if (0x7F..=0x9F).contains(&c) || c < 0x20 || c == 0xAD { 0 } else { 1 }
}

// ─────────────── WTF-8 decoding (stringWidth.cpp: wtf8SequenceLength, decodeWTF8RuneMultibyte) ───────────────

/// `wtf8SequenceLength`
fn wtf8_sequence_length(first: u8) -> usize {
    match first {
        0..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// `decodeWTF8RuneMultibyte` (esbuild's `decodeWTF8Rune`): invalid sequences decode to U+FFFD. `p` is zero-padded.
fn decode_wtf8_rune_multibyte(p: [u8; 4], len: usize) -> u32 {
    const REPLACEMENT: u32 = 0xFFFD;
    let s1 = p[1];
    if s1 & 0xC0 != 0x80 {
        return REPLACEMENT;
    }
    if len == 2 {
        let cp = (u32::from(p[0] & 0x1F) << 6) | u32::from(s1 & 0x3F);
        return if cp < 0x80 { REPLACEMENT } else { cp };
    }
    let s2 = p[2];
    if s2 & 0xC0 != 0x80 {
        return REPLACEMENT;
    }
    if len == 3 {
        let cp = (u32::from(p[0] & 0x0F) << 12) | (u32::from(s1 & 0x3F) << 6) | u32::from(s2 & 0x3F);
        return if cp < 0x800 { REPLACEMENT } else { cp };
    }
    let s3 = p[3];
    if s3 & 0xC0 != 0x80 {
        return REPLACEMENT;
    }
    let cp = (u32::from(p[0] & 0x07) << 18)
        | (u32::from(s1 & 0x3F) << 12)
        | (u32::from(s2 & 0x3F) << 6)
        | u32::from(s3 & 0x3F);
    if !(0x10000..=0x10FFFF).contains(&cp) { REPLACEMENT } else { cp }
}

/// The non-ASCII codepoint at the start of `chunk` and its byte length (the shared body of `visibleUTF8Width` and
/// `utf8WalkRun`: the lead byte decides the length even when the sequence is invalid or truncated).
fn decode_at(chunk: &[u8]) -> (u32, usize) {
    let byte = chunk[0];
    let skip = wtf8_sequence_length(byte);
    let mut cp_bytes = [byte, 0, 0, 0];
    let available = skip.min(chunk.len());
    cp_bytes[1..available].copy_from_slice(&chunk[1..available]);
    let cp = if skip > 1 { decode_wtf8_rune_multibyte(cp_bytes, skip) } else { 0xFFFD };
    (cp, skip)
}

// ─────────────── ANSI::consumeANSI<Utf8 = true> (ANSIHelpers.h) ───────────────

/// `ANSI::isEscapeCharacter`
fn is_escape_character(c: u8) -> bool {
    matches!(c, 0x1b | 0x9b | 0x9d | 0x90 | 0x98 | 0x9e | 0x9f)
}

/// `scanForByteInRange<Lo, Hi, Also...>`: index of the first byte in `lo..=hi` or in `also` at or after `from`.
fn scan_for_byte_in_range(bytes: &[u8], from: usize, lo: u8, hi: u8, also: &[u8]) -> Option<usize> {
    bytes[from..].iter().position(|&c| (lo..=hi).contains(&c) || also.contains(&c)).map(|i| from + i)
}

/// `scanForAnyByte<Targets...>`
fn scan_for_any_byte(bytes: &[u8], from: usize, targets: &[u8]) -> Option<usize> {
    bytes[from..].iter().position(|c| targets.contains(c)).map(|i| from + i)
}

#[derive(Clone, Copy, PartialEq)]
enum AnsiState {
    Start,
    GotEsc,
    IgnoreNextChar,
    InCsi,
    InOsc,
    InOscGotEsc,
    NeedSt,
    NeedStGotEsc,
}

/// `ANSI::consumeANSI<true>(start, end)`: the index just past the escape sequence (and any directly following ones)
/// that begins at `start`; `start` itself if there is none there. `bytes` is the whole input, `end` its length.
fn consume_ansi(bytes: &[u8], start: usize) -> usize {
    use AnsiState as S;
    let end = bytes.len();
    let mut state = S::Start;
    let mut it = start;
    while it != end {
        let c = bytes[it];
        let mut fallthrough_got_esc = false;
        match state {
            S::Start => {
                match c {
                    0x1b => state = S::GotEsc,
                    0x9b => state = S::InCsi,
                    0x9d => state = S::InOsc,
                    // Other sequences terminated by ST.
                    0x90 | 0x98 | 0x9e | 0x9f => state = S::NeedSt,
                    0xc2 => {
                        // UTF-8: the C1 introducers encode as 0xC2 0x9x.
                        if it + 1 == end {
                            return it;
                        }
                        let next = bytes[it + 1];
                        state = match next {
                            0x9b => S::InCsi,
                            0x9d => S::InOsc,
                            0x90 | 0x98 | 0x9e | 0x9f => S::NeedSt,
                            _ => return it,
                        };
                        it += 1;
                    }
                    _ => return it,
                }
            }
            S::InOscGotEsc | S::NeedStGotEsc => {
                if c == b'\\' {
                    state = S::Start; // ESC \ is the string terminator
                } else {
                    // Any other ESC aborted the payload and introduces a new sequence; this byte follows that ESC.
                    state = S::GotEsc;
                    fallthrough_got_esc = true;
                }
            }
            S::GotEsc => fallthrough_got_esc = true,
            S::IgnoreNextChar => {
                if c == 0x1b {
                    // ESC aborts the nF sequence and introduces a new one.
                    state = S::GotEsc;
                } else {
                    // Skip the whole codepoint, not just its lead byte.
                    while it + 1 != end && bytes[it + 1] & 0xC0 == 0x80 {
                        it += 1;
                    }
                    state = S::Start;
                }
            }
            S::InCsi => {
                // Final byte in [0x40, 0x7E]; ESC, CAN, SUB and the C1 ST (0xC2 0x9C) abort the sequence.
                let Some(term) = scan_for_byte_in_range(bytes, it, 0x40, 0x7e, &[0x1b, 0x18, 0x1a, 0xc2]) else {
                    return end;
                };
                it = term;
                if bytes[term] == 0xc2 {
                    if it + 1 == end {
                        return end;
                    }
                    it += 1; // second byte of the two-byte codepoint
                    if bytes[it] != 0x9c {
                        it += 1; // ordinary payload codepoint, keep scanning
                        continue;
                    }
                }
                state = if bytes[term] == 0x1b { S::GotEsc } else { S::Start };
            }
            S::InOsc | S::NeedSt => {
                // OSC ends at BEL or ST (ESC \, or 0xC2 0x9C); the other control strings at ST; CAN/SUB abort.
                let osc = state == S::InOsc;
                let term = if osc {
                    scan_for_any_byte(bytes, it, &[0x07, 0x1b, 0xc2, 0x18, 0x1a])
                } else {
                    scan_for_any_byte(bytes, it, &[0x1b, 0xc2, 0x18, 0x1a])
                };
                let Some(term) = term else { return end };
                it = term;
                if bytes[term] == 0x1b {
                    state = if osc { S::InOscGotEsc } else { S::NeedStGotEsc };
                } else {
                    if bytes[term] == 0xc2 {
                        if it + 1 == end {
                            return end;
                        }
                        it += 1; // second byte of the two-byte codepoint
                        if bytes[it] != 0x9c {
                            it += 1; // ordinary payload character, keep scanning
                            continue;
                        }
                    }
                    state = S::Start;
                }
            }
        }
        if fallthrough_got_esc {
            match c {
                // ESC aborts the sequence in progress and introduces a new one.
                0x1b => {}
                // CAN and SUB abort the sequence to ground; the byte is consumed.
                0x18 | 0x1a => state = S::Start,
                b'[' => state = S::InCsi,
                b']' => state = S::InOsc,
                // Other sequences terminated by ST.
                b'P' | b'X' | b'^' | b'_' => state = S::NeedSt,
                // 0x20-0x2F are intermediates (nF, e.g. ESC ( B), 0x30-0x7E the final byte of a two-byte escape.
                // Anything else cannot continue a sequence: only the ESC itself is consumed.
                0x20..=0x2f => state = S::IgnoreNextChar,
                0x30..=0x7e => state = S::Start,
                _ => return it,
            }
        }
        it += 1;
    }
    end
}

/// `findEscapeIntroducerUTF8`: the start of the next escape sequence in UTF-8 text at or after `from`: ESC, or the
/// two-byte encoding (0xC2 0x9x) of an 8-bit C1 introducer.
fn find_escape_introducer_utf8(bytes: &[u8], from: usize) -> Option<usize> {
    let mut p = from;
    loop {
        let q = scan_for_any_byte(bytes, p, &[0x1b, 0xc2])?;
        if bytes[q] == 0x1b {
            return Some(q);
        }
        if q + 1 != bytes.len() && bytes[q + 1] >= 0x90 && is_escape_character(bytes[q + 1]) {
            return Some(q);
        }
        p = q + 1; // an ordinary U+0080-U+00BF codepoint
    }
}

// ─────────────── the widths (stringWidth.cpp: visibleUTF8Width, utf8WalkRun, ...) ───────────────

/// `visibleUTF8Width`: width of a run with no escape sequences in it, per codepoint.
fn visible_utf8_width(run: &[u8]) -> usize {
    let mut bytes = run;
    let mut len = 0;
    loop {
        let i = bytes.iter().position(|&b| b > 0x7F).unwrap_or(bytes.len());
        len += bytes[..i].iter().map(|&b| visible_latin1_width_scalar(b)).sum::<usize>();
        if i == bytes.len() {
            break;
        }
        let (cp, skip) = decode_at(&bytes[i..]);
        len += visible_codepoint_width(cp);
        bytes = &bytes[(i + skip).min(bytes.len())..];
    }
    len
}

/// `visibleUTF8WidthExcludeANSI`
fn visible_utf8_width_exclude_ansi(input: &[u8]) -> usize {
    let mut p = 0;
    let mut width = 0;
    while p != input.len() {
        let esc = find_escape_introducer_utf8(input, p);
        width += visible_utf8_width(&input[p..esc.unwrap_or(input.len())]);
        let Some(esc) = esc else { break };
        // `esc` is an introducer, so consume_ansi always makes progress.
        p = consume_ansi(input, esc);
    }
    width
}

/// `utf8WalkRun`: walk `input[start..start + len]`, adding visible width to `w`. The absolute byte index at which the
/// next codepoint would exceed `max_width`, or `None` if the whole run fits.
fn utf8_walk_run(input: &[u8], start: usize, len: usize, max_width: usize, w: &mut usize) -> Option<usize> {
    let mut at = start;
    let end = start + len;
    loop {
        let i = input[at..end].iter().position(|&b| b > 0x7F).unwrap_or(end - at);
        if at + i == end {
            break;
        }
        // ASCII run: each printable char is width 1.
        for k in 0..i {
            let cw = visible_latin1_width_scalar(input[at + k]);
            if *w + cw > max_width {
                return Some(at + k);
            }
            *w += cw;
        }
        let (cp, skip) = decode_at(&input[at + i..end]);
        let cw = visible_codepoint_width(cp);
        if *w + cw > max_width {
            return Some(at + i);
        }
        *w += cw;
        at = (at + i + skip).min(end);
    }
    for k in at..end {
        let cw = visible_latin1_width_scalar(input[k]);
        if *w + cw > max_width {
            return Some(k);
        }
        *w += cw;
    }
    None
}

/// `utf8IndexAtWidthExcludeANSI`: the byte index of the first codepoint that would take the visible width past
/// `max_width` (`input.len()` if all fits); escape sequences are zero-width and always in the prefix.
fn utf8_index_at_width_exclude_ansi(input: &[u8], max_width: usize) -> usize {
    let end = input.len();
    let mut p = 0;
    let mut w = 0;
    while p != end {
        let esc = find_escape_introducer_utf8(input, p);
        let run_len = esc.unwrap_or(end) - p;
        if let Some(stop) = utf8_walk_run(input, p, run_len, max_width, &mut w) {
            return stop;
        }
        let Some(esc) = esc else { break };
        // An unterminated sequence consumes the rest of the input.
        p = consume_ansi(input, esc);
    }
    end
}

fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(ptr, len) } }
}

/// `Bun__visibleWidthExcludeANSI_utf8`
#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__visibleWidthExcludeANSI_utf8(ptr: *const u8, len: usize) -> usize {
    visible_utf8_width_exclude_ansi(slice(ptr, len))
}

/// `Bun__visibleWidthExcludeANSI_utf8IndexAtWidth`
#[unsafe(no_mangle)]
unsafe extern "C" fn Bun__visibleWidthExcludeANSI_utf8IndexAtWidth(ptr: *const u8, len: usize, max_width: usize) -> usize {
    utf8_index_at_width_exclude_ansi(slice(ptr, len), max_width)
}
