//! Bun's shell parser (`bun_shell_parser`) behind a pointer+length C ABI for wasm64.
//!
//! `shell_parse` takes the script as `Bun.$` builds it (`shell_body.rs` `shell_cmd_from_js`): template strings that
//! need escaping are `\x08__bunstr_<i>\x08` references into `strings` (NUL-separated, as Bun forbids NUL in shell
//! arguments), other JS values `\x08__bun_<i>\x08` references counted by `jsobjs`. The result (`result_ptr`,
//! `result_len`) is a status byte, 0 then the AST as JSON (`json_fmt`, the shape `shellInternals.parse` prints) or 1
//! then the error message Bun would throw.

use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};
use std::cell::RefCell;

use bun_core::StringView;
use bun_shell_parser::parse::{LexerAscii, LexerUnicode};
use bun_shell_parser::{Parser, json_fmt};
// The C/C++ stand-ins (simdutf, highway, crash handler) bun_core links against.
use bun_wasm_stubs as _;
// bun_core's syscalls, as -ENOSYS stubs: the parser makes none.
use bun_sys_host as _;

// bun_core's WTF-string constructors (C++): linked in, never called, as the parser only borrows UTF-8.
macro_rules! unreachable_c {
    ($($name:ident),* $(,)?) => {$(
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() {
            unreachable!(concat!(stringify!($name), " is not available in the shell parser"))
        }
    )*};
}
unreachable_c!(BunString__fromBytes, BunString__fromLatin1, BunString__fromUTF16, BunString__fromUTF16ToLatin1);

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { std_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        unsafe { std_dealloc(ptr, Layout::from_size_align_unchecked(len, 1)) }
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(ptr, len) } }
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

fn parse(src: &[u8], strings: &[u8], jsobjs: u32) -> Result<String, Vec<u8>> {
    let views: Vec<StringView<'_>> =
        if strings.is_empty() { Vec::new() } else { strings.split(|&b| b == 0).map(StringView::borrow_utf8).collect() };
    let refs = StringView::as_strings(&views);
    let arena = bun_alloc::Arena::new();
    let lex = if src.is_ascii() {
        let mut lexer = LexerAscii::new(&arena, src, refs, jsobjs);
        lexer.lex().map_err(|e| format!("{e:?}").into_bytes())?;
        lexer.get_result()
    } else {
        let mut lexer = LexerUnicode::new(&arena, src, refs, jsobjs);
        lexer.lex().map_err(|e| format!("{e:?}").into_bytes())?;
        lexer.get_result()
    };
    if !lex.errors.is_empty() {
        return Err(lex.combine_errors(&arena).to_vec());
    }
    let mut parser = Parser::new(&arena, lex);
    match parser.parse() {
        Ok(script) => Ok(format!("{}", json_fmt::script_json_fmt(&script))),
        Err(_) => Err(parser.combine_errors().to_vec()),
    }
}

/// 0 when it parsed (the result is `0` + JSON), 1 when it didn't (`1` + the message).
///
/// # Safety
/// Both ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn shell_parse(src: *const u8, src_len: usize, strings: *const u8, strings_len: usize, jsobjs: u32) -> u32 {
    let (src, strings) = unsafe { (bytes(src, src_len), bytes(strings, strings_len)) };
    let (status, body) = match parse(src, strings, jsobjs) {
        Ok(json) => (0u8, json.into_bytes()),
        Err(msg) => (1u8, msg),
    };
    RESULT.with(|r| {
        let mut r = r.borrow_mut();
        r.clear();
        r.push(status);
        r.extend_from_slice(&body);
    });
    status as u32
}

fn braces(word: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    use bun_shell_parser::braces;
    let mut lexed = if word.is_ascii() {
        braces::Lexer::tokenize(word)
    } else {
        braces::NewLexer::<{ braces::StringEncoding::Wtf8 }>::tokenize(word)
    }
    .map_err(|e| format!("failed to tokenize braces: {e:?}"))?;
    let count = braces::calculate_expanded_amount(&lexed.tokens[..]);
    if count == 0 {
        return Ok(vec![word.to_vec()]);
    }
    const MAX_BRACE_EXPANSIONS: u32 = 65536;
    if count > MAX_BRACE_EXPANSIONS {
        return Err(format!("too many brace expansions ({count} > {MAX_BRACE_EXPANSIONS})"));
    }
    let mut out: Vec<Vec<u8>> = (0..count).map(|_| Vec::new()).collect();
    let arena = bun_alloc::Arena::new();
    braces::expand(&arena, &mut lexed.tokens[..], &mut out[..], lexed.contains_nested).map_err(|e| match e {
        braces::ParserError::TooManyBraces => "too many braces in brace expansion".to_string(),
        braces::ParserError::UnexpectedToken => "unexpected token while expanding braces".to_string(),
        braces::ParserError::OutOfMemory => "out of memory".to_string(),
    })?;
    Ok(out)
}

/// Brace expansion (`Bun.$.braces`, and the interpreter's `{a,b}` words): 0 then the words NUL-separated, or 1 then
/// the message. Characters that must stay literal come backslash-escaped, as `Expansion::do_brace_expand` passes them.
///
/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn shell_braces(word: *const u8, word_len: usize) -> u32 {
    let word = unsafe { bytes(word, word_len) };
    let (status, body) = match braces(word) {
        Ok(words) => (0u8, words.join(&0u8)),
        Err(msg) => (1u8, msg.into_bytes()),
    };
    RESULT.with(|r| {
        let mut r = r.borrow_mut();
        r.clear();
        r.push(status);
        r.extend_from_slice(&body);
    });
    status as u32
}
