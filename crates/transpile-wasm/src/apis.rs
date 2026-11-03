//! `Bun.XML.parse` (bun_runtime's `XMLObject.rs`) over `bun_parsers::xml`, for the playground's shims.

use bun_alloc::Arena;

use crate::Output;

fn output(result: Result<Vec<u8>, Vec<u8>>) -> *mut Output {
    let (status, bytes) = match result {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { core::slice::from_raw_parts(ptr, len) } }
}

// Bits of `xml_parse_c`'s `flags`.
const XML_COMPACT: u32 = 1;
/// The input is bytes (a buffer or Blob: encoding detection, BOM), not a string's text as UTF-8.
const XML_BYTES: u32 = 2;

/// `Bun.XML.parse(input, { compact })`: the result as JSON, or status 1 with the message of Bun's `SyntaxError`
/// (`XML Parse error: ...`), or status 2 with "StackOverflow".
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xml_parse_c(ptr: *const u8, len: usize, flags: u32) -> *mut Output {
    use bun_parsers::xml;
    let bytes = input(ptr, len);
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();
    let source = bun_ast::Source::init_path_string(b"input.xml", bytes);
    let mut log = bun_ast::Log::init();
    let encoding = if flags & XML_BYTES != 0 { xml::InputEncoding::Bytes } else { xml::InputEncoding::Text };
    let options = xml::Options { compact: flags & XML_COMPACT != 0, encoding };
    let root = match xml::XML::parse(&source, &mut log, &arena, options) {
        Ok(root) => root,
        Err(bun_parsers::Error::StackOverflow) => {
            let out = output(Err(b"StackOverflow".to_vec()));
            unsafe { (*out).status = 2 };
            return out;
        }
        Err(_) => {
            let mut message = b"XML Parse error: ".to_vec();
            match log.msgs.first() {
                Some(msg) => message.extend_from_slice(&msg.data.text),
                None => message.extend_from_slice(b"Unable to parse XML"),
            }
            return output(Err(message));
        }
    };
    let root = match bun_parsers::json::materialize(&root, &source, &mut log, &arena) {
        Ok(root) => root,
        Err(_) => {
            let out = output(Err(b"StackOverflow".to_vec()));
            unsafe { (*out).status = 2 };
            return out;
        }
    };
    let mut printer = bun_js_printer::BufferPrinter::init(bun_js_printer::BufferWriter::init());
    if bun_js_printer::print_json(&mut printer, root, &source, bun_js_printer::PrintJsonOptions { mangled_props: None, ..Default::default() }).is_err() {
        let out = output(Err(b"StackOverflow".to_vec()));
        unsafe { (*out).status = 2 };
        return out;
    }
    output(Ok(printer.ctx.written_without_trailing_zero().to_vec()))
}
