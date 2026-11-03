//! `Bun.markdown` and `Bun.XML.parse` (bun_runtime's `MarkdownObject.rs`, `XMLObject.rs`) over `bun_md` and
//! `bun_parsers::xml`, for the playground's shims. What needs JS values (the `render` callbacks, React elements) is
//! done in JS from `markdown_events_c`'s events.

use bun_alloc::Arena;
use bun_md::root as md;
use bun_md::types::{BlockType, SpanDetail, SpanType, TextType};

use crate::Output;

// Bits of the `options` of `markdown_*_c`: `md::Options` as `Bun.markdown`'s options give them (the JS side applies
// their defaults and the `autolinks`/`headings` shorthands).
const TABLES: u32 = 1;
const STRIKETHROUGH: u32 = 1 << 1;
const TASKLISTS: u32 = 1 << 2;
const AUTOLINK_URL: u32 = 1 << 3;
const AUTOLINK_WWW: u32 = 1 << 4;
const AUTOLINK_EMAIL: u32 = 1 << 5;
const HARD_SOFT_BREAKS: u32 = 1 << 6;
const WIKI_LINKS: u32 = 1 << 7;
const UNDERLINE: u32 = 1 << 8;
const LATEX_MATH: u32 = 1 << 9;
const COLLAPSE_WHITESPACE: u32 = 1 << 10;
const PERMISSIVE_ATX_HEADERS: u32 = 1 << 11;
const NO_INDENTED_CODE_BLOCKS: u32 = 1 << 12;
const NO_HTML_BLOCKS: u32 = 1 << 13;
const NO_HTML_SPANS: u32 = 1 << 14;
const TAG_FILTER: u32 = 1 << 15;
const HEADING_IDS: u32 = 1 << 16;
const AUTOLINK_HEADINGS: u32 = 1 << 17;

fn md_options(bits: u32) -> md::Options {
    let on = |b: u32| bits & b != 0;
    let mut o = md::Options::default();
    o.tables = on(TABLES);
    o.strikethrough = on(STRIKETHROUGH);
    o.tasklists = on(TASKLISTS);
    o.permissive_url_autolinks = on(AUTOLINK_URL);
    o.permissive_www_autolinks = on(AUTOLINK_WWW);
    o.permissive_email_autolinks = on(AUTOLINK_EMAIL);
    o.hard_soft_breaks = on(HARD_SOFT_BREAKS);
    o.wiki_links = on(WIKI_LINKS);
    o.underline = on(UNDERLINE);
    o.latex_math = on(LATEX_MATH);
    o.collapse_whitespace = on(COLLAPSE_WHITESPACE);
    o.permissive_atx_headers = on(PERMISSIVE_ATX_HEADERS);
    o.no_indented_code_blocks = on(NO_INDENTED_CODE_BLOCKS);
    o.no_html_blocks = on(NO_HTML_BLOCKS);
    o.no_html_spans = on(NO_HTML_SPANS);
    o.tag_filter = on(TAG_FILTER);
    o.heading_ids = on(HEADING_IDS);
    o.autolink_headings = on(AUTOLINK_HEADINGS);
    o
}

/// The name of a parser error, as the `Output`'s text for status 1 (the JS side throws Bun's error for it).
fn parser_error(e: bun_md::parser::ParserError) -> Vec<u8> {
    use bun_md::parser::ParserError as E;
    match e {
        E::OutOfMemory => b"OutOfMemory".to_vec(),
        E::JSError => b"JSError".to_vec(),
        E::StackOverflow => b"StackOverflow".to_vec(),
        E::InputTooLarge => b"InputTooLarge".to_vec(),
        E::TooManyBlocks => b"TooManyBlocks".to_vec(),
    }
}

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

/// `Bun.markdown.html(input, options)`: the HTML, or status 1 with a parser error's name.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn markdown_html_c(ptr: *const u8, len: usize, options: u32) -> *mut Output {
    output(md::render_to_html_with_options(input(ptr, len), md_options(options)).map(Vec::from).map_err(parser_error))
}

// Bits of `markdown_ansi_c`'s `theme` (`Bun.markdown.ansi`'s theme, defaults applied).
const ANSI_COLORS: u32 = 1;
const ANSI_HYPERLINKS: u32 = 2;
const ANSI_KITTY_GRAPHICS: u32 = 4;
const ANSI_LIGHT: u32 = 8;

/// `Bun.markdown.ansi(input, theme)`: the terminal text, or status 1 with a parser error's name.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn markdown_ansi_c(ptr: *const u8, len: usize, theme: u32, columns: u32) -> *mut Output {
    let theme = bun_md::ansi_renderer::Theme {
        colors: theme & ANSI_COLORS != 0,
        hyperlinks: theme & ANSI_HYPERLINKS != 0,
        kitty_graphics: theme & ANSI_KITTY_GRAPHICS != 0,
        light: theme & ANSI_LIGHT != 0,
        columns: columns as u16,
        remote_image_paths: None,
        image_base_dir: None,
    };
    output(match bun_md::ansi_renderer::render_to_ansi(input(ptr, len), md::Options::TERMINAL, theme) {
        Ok(Some(text)) => Ok(Vec::from(text)),
        Ok(None) => Err(b"OutOfMemory".to_vec()),
        Err(e) => Err(parser_error(e)),
    })
}

/// The parser's callbacks as a JSON array of events, for `Bun.markdown.render` and `.react` (what
/// `MarkdownObject.rs`'s renderers read from the source is resolved here):
/// - `["b", block, extra]`: enter a block (`BlockType` as a number). `extra`: a heading's level, an ordered list's
///   start, a list item's task mark (`null`, `false` unchecked, `true` checked), a fenced code block's language
///   (`""` for none), a table cell's alignment (`null` for none); else 0.
/// - `["B", block, slug]`: leave it; `slug` is a heading's id with heading ids on, else `null`.
/// - `["s", span, href, title]`, `["S", span]`: enter and leave a span (`SpanType`).
/// - `["t", text, content]`: text (`TextType`); entities are decoded (`content` is `""` for a null char, a break).
struct Events<'a> {
    out: Vec<u8>,
    src: &'a [u8],
    headings: bun_md::helpers::HeadingIdTracker,
}

impl Events<'_> {
    fn sep(&mut self) {
        if self.out.len() > 1 {
            self.out.push(b',');
        }
    }
    fn str(&mut self, s: &[u8]) {
        crate::json_str(&mut self.out, s);
    }
}

/// `MarkdownObject.rs`'s `extract_language`: the info string up to white space.
fn language(src: &[u8], beg: u32) -> &[u8] {
    let beg = (beg as usize).min(src.len());
    let end = src[beg..].iter().position(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r')).map_or(src.len(), |n| beg + n);
    &src[beg..end]
}

impl bun_md::types::RendererImpl for Events<'_> {
    fn enter_block(&mut self, block: BlockType, data: u32, flags: u32) -> bun_md::types::JsResult<()> {
        if block == BlockType::H {
            self.headings.enter_heading();
        }
        self.sep();
        self.out.extend_from_slice(format!("[\"b\",{},", block as u8).as_bytes());
        match block {
            BlockType::H | BlockType::Ol => self.out.extend_from_slice(data.to_string().as_bytes()),
            BlockType::Li => {
                let mark = bun_md::types::task_mark_from_data(data);
                let v: &[u8] = if mark == 0 { b"null" } else if bun_md::types::is_task_checked(mark) { b"true" } else { b"false" };
                self.out.extend_from_slice(v);
            }
            BlockType::Code => {
                let lang = if flags & md::BLOCK_FENCED_CODE != 0 { language(self.src, data) } else { b"" };
                self.str(lang);
            }
            BlockType::Th | BlockType::Td => match bun_md::types::alignment_name(bun_md::types::alignment_from_data(data)) {
                Some(name) => self.str(name),
                None => self.out.extend_from_slice(b"null"),
            },
            _ => self.out.push(b'0'),
        }
        self.out.push(b']');
        Ok(())
    }

    fn leave_block(&mut self, block: BlockType, _data: u32) -> bun_md::types::JsResult<()> {
        self.sep();
        self.out.extend_from_slice(format!("[\"B\",{},", block as u8).as_bytes());
        if block == BlockType::H {
            let slug = self.headings.leave_heading().map(<[u8]>::to_vec);
            match slug {
                Some(s) => self.str(&s),
                None => self.out.extend_from_slice(b"null"),
            }
            self.headings.clear_after_heading();
        } else {
            self.out.extend_from_slice(b"null");
        }
        self.out.push(b']');
        Ok(())
    }

    fn enter_span(&mut self, span: SpanType, detail: SpanDetail<'_>) -> bun_md::types::JsResult<()> {
        self.sep();
        self.out.extend_from_slice(format!("[\"s\",{},", span as u8).as_bytes());
        self.str(detail.href);
        self.out.push(b',');
        self.str(detail.title);
        self.out.push(b']');
        Ok(())
    }

    fn leave_span(&mut self, span: SpanType) -> bun_md::types::JsResult<()> {
        self.sep();
        self.out.extend_from_slice(format!("[\"S\",{}]", span as u8).as_bytes());
        Ok(())
    }

    fn text(&mut self, text: TextType, content: &[u8]) -> bun_md::types::JsResult<()> {
        self.headings.track_text(text, content);
        self.sep();
        self.out.extend_from_slice(format!("[\"t\",{},", text as u8).as_bytes());
        match text {
            TextType::NullChar | TextType::Br | TextType::Softbr => self.out.extend_from_slice(b"\"\""),
            TextType::Entity => {
                let mut buf = [0u8; 8];
                let decoded = bun_md::helpers::decode_entity_to_utf8(content, &mut buf).unwrap_or(content).to_vec();
                self.str(&decoded);
            }
            _ => self.str(content),
        }
        self.out.push(b']');
        Ok(())
    }
}

/// `markdown_events_c`'s events (see `Events`), or status 1 with a parser error's name.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn markdown_events_c(ptr: *const u8, len: usize, options: u32) -> *mut Output {
    let src = input(ptr, len);
    let options = md_options(options);
    let mut events = Events { out: b"[".to_vec(), src, headings: bun_md::helpers::HeadingIdTracker::init(options.heading_ids) };
    let result = md::render_with_renderer(src, options, md::Renderer { ptr: &mut events });
    output(result.map_err(parser_error).map(|()| {
        events.out.push(b']');
        events.out
    }))
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
