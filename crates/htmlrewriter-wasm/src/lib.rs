//! lol-html (Bun's fork: Cloudflare's streaming HTML rewriter plus handler suspension) behind a C ABI for wasm64:
//! the engine under `HTMLRewriter`. The host (apps/playground/src/worker/htmlRewriter.ts) keeps the JS handlers.
//!
//! Flow: `rw_new`, then `rw_on` / `rw_on_document` per registration (a handler id and which callbacks it has),
//! `rw_open`, then `rw_write` per chunk and `rw_end`, reading the output with `rw_out_*`, and `rw_free`.
//! Whenever lol-html reaches a rewritable unit a registered handler wants, it calls the import `hr_event`, which
//! gets a unit id; the host then reads and mutates the unit through the `unit_*` / `el_*` / ... exports. An id is
//! valid until the handler returns (afterwards every export answers `DETACHED`), or, when `hr_event` asks to
//! suspend, until `rw_resume` returns: an async handler runs on while lol-html is parked on the unit.
//!
//! Strings go in as pointer+length (buffers from `alloc`); strings come out through `ret_ptr()` after the export
//! returned their length. Errors (`ERR`, -3) leave their text in `err_ptr()` / `err_len()`.

use std::alloc::{Layout, alloc as std_alloc, dealloc as std_dealloc};
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use lol_html::errors::{RewritingError, SuspensionRequest};
use lol_html::html_content::{
    Comment, ContentType, Doctype, DocumentEnd, Element, EndTag, TextChunk, UserData,
};
use lol_html::{
    AsciiCompatibleEncoding, DocumentContentHandlers, ElementContentHandlers, HandlerResult, HtmlRewriter,
    MemorySettings, OutputSink, Selector, Settings,
};

/// `hr_event` kinds.
const ELEMENT: u32 = 0;
const EL_COMMENT: u32 = 1;
const EL_TEXT: u32 = 2;
const DOCTYPE: u32 = 3;
const DOC_COMMENT: u32 = 4;
const DOC_TEXT: u32 = 5;
const DOC_END: u32 = 6;
const END_TAG: u32 = 7;

/// `hr_event` answers: run on, abort the rewrite (the host keeps the exception), park the unit.
const CONTINUE: i32 = 0;
const SUSPEND: i32 = 2;

/// Results of the unit exports.
const DETACHED: i32 = -1;
const NULL: i32 = -2;
const ERR: i32 = -3;
const UNSUPPORTED: i32 = -4;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Runs the host's handler `handler` of rewriter `rw` on unit `unit`; see the constants above.
    fn hr_event(rw: u32, handler: u32, kind: u32, unit: u32) -> i32;
}

// ───────────────────────────── memory ─────────────────────────────

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

/// The host writes UTF-8 (a JS string encoded); anything else is repaired rather than trusted.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Cow<'a, str> {
    String::from_utf8_lossy(unsafe { bytes(ptr, len) })
}

// ───────────────────────────── state ─────────────────────────────

/// A lifetime-erased unit lol-html lent to a handler.
#[derive(Clone, Copy)]
enum Unit {
    Element(*mut Element<'static, 'static>),
    Text(*mut TextChunk<'static>),
    Comment(*mut Comment<'static>),
    Doctype(*mut Doctype<'static>),
    DocEnd(*mut DocumentEnd<'static>),
    EndTag(*mut EndTag<'static>),
}

struct Sink(Rc<RefCell<Vec<u8>>>);

impl OutputSink for Sink {
    fn handle_chunk(&mut self, chunk: &[u8]) {
        self.0.borrow_mut().extend_from_slice(chunk);
    }
}

type Rewriter = HtmlRewriter<'static, Sink>;

struct Rw {
    /// (selector, handler id, bit 0 element, bit 1 comments, bit 2 text)
    elements: Vec<(Selector, u32, u32)>,
    /// (handler id, bit 0 doctype, bit 1 comments, bit 2 text, bit 3 end)
    documents: Vec<(u32, u32)>,
    out: Rc<RefCell<Vec<u8>>>,
    rewriter: Option<Rewriter>,
    /// The unit a handler suspended on, until `rw_resume` returns.
    parked: Option<u32>,
}

thread_local! {
    static REWRITERS: RefCell<HashMap<u32, Rw>> = RefCell::new(HashMap::new());
    static UNITS: RefCell<HashMap<u32, Unit>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u32> = const { Cell::new(1) };
    /// Set by the handler closure that asked to suspend: its unit id and `hr_event` kind.
    static PENDING: Cell<Option<(u32, u32)>> = const { Cell::new(None) };
    static RET: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static MESSAGE: RefCell<String> = const { RefCell::new(String::new()) };
}

fn next_id() -> u32 {
    NEXT.with(|n| {
        let id = n.get();
        n.set(if id == u32::MAX { 1 } else { id + 1 });
        id
    })
}

fn register(unit: Unit) -> u32 {
    let id = next_id();
    UNITS.with(|u| u.borrow_mut().insert(id, unit));
    id
}

fn unregister(id: u32) {
    UNITS.with(|u| u.borrow_mut().remove(&id));
}

fn unit_of(id: u32) -> Option<Unit> {
    UNITS.with(|u| u.borrow().get(&id).copied())
}

fn fail(message: impl core::fmt::Display) -> i32 {
    MESSAGE.with(|m| *m.borrow_mut() = message.to_string());
    ERR
}

fn ret(s: &str) -> i32 {
    RET.with(|r| {
        let mut r = r.borrow_mut();
        r.clear();
        r.extend_from_slice(s.as_bytes());
    });
    s.len() as i32
}

fn ret_opt(s: Option<String>) -> i32 {
    match s {
        Some(s) => ret(&s),
        None => NULL,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ret_ptr() -> *const u8 {
    RET.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn err_ptr() -> *const u8 {
    MESSAGE.with(|m| m.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn err_len() -> usize {
    MESSAGE.with(|m| m.borrow().len())
}

// ───────────────────────────── rewriter ─────────────────────────────

fn dispatch(rw: u32, handler: u32, kind: u32, unit: Unit) -> HandlerResult {
    let id = register(unit);
    match unsafe { hr_event(rw, handler, kind, id) } {
        CONTINUE => {
            unregister(id);
            Ok(())
        }
        SUSPEND => {
            PENDING.with(|p| p.set(Some((id, kind))));
            Err(Box::new(SuspensionRequest))
        }
        _ => {
            unregister(id);
            Err("The rewriter has been stopped.".into())
        }
    }
}

/// A new rewriter with no handlers yet.
#[unsafe(no_mangle)]
pub extern "C" fn rw_new() -> u32 {
    let id = next_id();
    REWRITERS.with(|r| {
        r.borrow_mut().insert(
            id,
            Rw { elements: Vec::new(), documents: Vec::new(), out: Rc::default(), rewriter: None, parked: None },
        )
    });
    id
}

/// Whether `selector` parses (0), or `ERR` with lol-html's message.
///
/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn selector_check(ptr: *const u8, len: usize) -> i32 {
    match unsafe { text(ptr, len) }.parse::<Selector>() {
        Ok(_) => 0,
        Err(e) => fail(e),
    }
}

/// `HTMLRewriter#on`: `flags` is which of `element`, `comments`, `text` the handler has (bits 0 to 2).
///
/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_on(rw: u32, ptr: *const u8, len: usize, handler: u32, flags: u32) -> i32 {
    let selector = match unsafe { text(ptr, len) }.parse::<Selector>() {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    REWRITERS.with(|r| r.borrow_mut().get_mut(&rw).map(|rw| rw.elements.push((selector, handler, flags))));
    0
}

/// `HTMLRewriter#onDocument`: `flags` is which of `doctype`, `comments`, `text`, `end` the handler has (bits 0 to 3).
#[unsafe(no_mangle)]
pub extern "C" fn rw_on_document(rw: u32, handler: u32, flags: u32) {
    REWRITERS.with(|r| r.borrow_mut().get_mut(&rw).map(|rw| rw.documents.push((handler, flags))));
}

/// Builds the rewriter from the registrations; call once, before the first write.
#[unsafe(no_mangle)]
pub extern "C" fn rw_open(rw: u32) {
    REWRITERS.with(|r| {
        let mut r = r.borrow_mut();
        let Some(state) = r.get_mut(&rw) else { return };
        let mut elements = Vec::with_capacity(state.elements.len());
        for (selector, handler, flags) in &state.elements {
            let handler = *handler;
            let mut h = ElementContentHandlers::default();
            if flags & 1 != 0 {
                h = h.element(move |el: &mut Element| {
                    let el = core::ptr::from_mut(el).cast();
                    dispatch(rw, handler, ELEMENT, Unit::Element(el))
                });
            }
            if flags & 2 != 0 {
                h = h.comments(move |c: &mut Comment| {
                    let c = core::ptr::from_mut(c).cast();
                    dispatch(rw, handler, EL_COMMENT, Unit::Comment(c))
                });
            }
            if flags & 4 != 0 {
                h = h.text(move |t: &mut TextChunk| {
                    let t = core::ptr::from_mut(t).cast();
                    dispatch(rw, handler, EL_TEXT, Unit::Text(t))
                });
            }
            elements.push((Cow::Owned(selector.clone()), h));
        }
        let mut documents = Vec::with_capacity(state.documents.len());
        for (handler, flags) in &state.documents {
            let handler = *handler;
            let mut h = DocumentContentHandlers::default();
            if flags & 1 != 0 {
                h = h.doctype(move |d: &mut Doctype| {
                    let d = core::ptr::from_mut(d).cast();
                    dispatch(rw, handler, DOCTYPE, Unit::Doctype(d))
                });
            }
            if flags & 2 != 0 {
                h = h.comments(move |c: &mut Comment| {
                    let c = core::ptr::from_mut(c).cast();
                    dispatch(rw, handler, DOC_COMMENT, Unit::Comment(c))
                });
            }
            if flags & 4 != 0 {
                h = h.text(move |t: &mut TextChunk| {
                    let t = core::ptr::from_mut(t).cast();
                    dispatch(rw, handler, DOC_TEXT, Unit::Text(t))
                });
            }
            if flags & 8 != 0 {
                h = h.end(move |e: &mut DocumentEnd| {
                    let e = core::ptr::from_mut(e).cast();
                    dispatch(rw, handler, DOC_END, Unit::DocEnd(e))
                });
            }
            documents.push(h);
        }
        // As Bun builds it: UTF-8, lenient parsing, memory capped only by the wasm's own.
        state.rewriter = Some(HtmlRewriter::new(
            Settings {
                element_content_handlers: elements,
                document_content_handlers: documents,
                encoding: AsciiCompatibleEncoding::utf_8(),
                memory_settings: MemorySettings {
                    max_allowed_memory_usage: u32::MAX as usize,
                    ..MemorySettings::new()
                },
                strict: false,
                enable_esi_tags: false,
                adjust_charset_on_meta_tag: false,
            },
            Sink(state.out.clone()),
        ));
    });
}

const DONE: i32 = 0;
const SUSPENDED: i32 = 1;
const FAILED: i32 = 2;

/// Runs one `write` / `end_mut` / `resume` of the rewriter. `DONE`, `SUSPENDED` (a handler is parked: await it,
/// then `rw_resume`) or `FAILED` (the rewriter is spent; `err_ptr` has lol-html's message, if a handler
/// stopped it the host holds that handler's own exception).
fn drive(rw: u32, f: impl FnOnce(&mut Rewriter) -> Result<(), RewritingError>) -> i32 {
    // Out of the table while it runs: a handler's host code must be able to call back in for other rewriters.
    let Some(mut state) = REWRITERS.with(|r| r.borrow_mut().remove(&rw)) else { return FAILED };
    let Some(mut rewriter) = state.rewriter.take() else {
        REWRITERS.with(|r| r.borrow_mut().insert(rw, state));
        return FAILED;
    };
    PENDING.with(|p| p.set(None));
    let result = f(&mut rewriter);
    // The unit that was parked is over, whichever way this call ended.
    if let Some(old) = state.parked.take() {
        unregister(old);
    }
    let status = match result {
        Ok(()) => DONE,
        Err(RewritingError::Suspended) => {
            let (id, kind) = PENDING.with(|p| p.take()).expect("lol-html suspended without a handler asking");
            // lol-html moved the unit into its parked state: point the id there.
            let unit = match kind {
                ELEMENT => rewriter.suspended_element().map(|u| Unit::Element(core::ptr::from_mut(u).cast())),
                EL_COMMENT | DOC_COMMENT => rewriter.suspended_comment().map(|u| Unit::Comment(core::ptr::from_mut(u))),
                EL_TEXT | DOC_TEXT => rewriter.suspended_text_chunk().map(|u| Unit::Text(core::ptr::from_mut(u))),
                DOCTYPE => rewriter.suspended_doctype().map(|u| Unit::Doctype(core::ptr::from_mut(u))),
                DOC_END => rewriter.suspended_document_end().map(|u| Unit::DocEnd(core::ptr::from_mut(u))),
                _ => rewriter.suspended_end_tag().map(|u| Unit::EndTag(core::ptr::from_mut(u))),
            };
            match unit {
                Some(unit) => {
                    UNITS.with(|u| u.borrow_mut().insert(id, unit));
                    state.parked = Some(id);
                }
                None => unregister(id),
            }
            SUSPENDED
        }
        Err(e) => {
            fail(e);
            FAILED
        }
    };
    state.rewriter = Some(rewriter);
    REWRITERS.with(|r| r.borrow_mut().insert(rw, state));
    status
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_write(rw: u32, ptr: *const u8, len: usize) -> i32 {
    let chunk = unsafe { bytes(ptr, len) };
    drive(rw, |r| r.write(chunk))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_end(rw: u32) -> i32 {
    drive(rw, |r| r.end_mut())
}

/// Continues after a suspension (the handler's promise settled).
#[unsafe(no_mangle)]
pub extern "C" fn rw_resume(rw: u32) -> i32 {
    drive(rw, |r| r.resume())
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_out_ptr(rw: u32) -> *const u8 {
    REWRITERS.with(|r| r.borrow().get(&rw).map_or(core::ptr::null(), |s| s.out.borrow().as_ptr()))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_out_len(rw: u32) -> usize {
    REWRITERS.with(|r| r.borrow().get(&rw).map_or(0, |s| s.out.borrow().len()))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_out_clear(rw: u32) {
    REWRITERS.with(|r| {
        if let Some(s) = r.borrow().get(&rw) {
            s.out.borrow_mut().clear();
        }
    });
}

/// Drops the rewriter (and any unit it still has parked).
#[unsafe(no_mangle)]
pub extern "C" fn rw_free(rw: u32) {
    let state = REWRITERS.with(|r| r.borrow_mut().remove(&rw));
    if let Some(parked) = state.and_then(|s| s.parked) {
        unregister(parked);
    }
}

// ───────────────────────────── units ─────────────────────────────

/// The unit `$id` is, or `DETACHED`. Units are valid exactly while their handler runs (or is parked).
macro_rules! with {
    ($id:expr, $pat:pat => $body:expr) => {
        match unit_of($id) {
            None => DETACHED,
            Some($pat) => $body,
            Some(_) => UNSUPPORTED,
        }
    };
}

fn flag(b: bool) -> i32 {
    b as i32
}

/// `before`/`after`/`prepend`/`append`/`replace`/`setInnerContent` as `op` 0 to 5; `html` is `{ html: true }`.
///
/// # Safety
/// The range must be readable; the unit pointers were lent by lol-html to a handler still running.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn unit_content(id: u32, op: u32, ptr: *const u8, len: usize, html: u32) -> i32 {
    let content = unsafe { text(ptr, len) };
    let ty = if html != 0 { ContentType::Html } else { ContentType::Text };
    let Some(unit) = unit_of(id) else { return DETACHED };
    unsafe {
        match (unit, op) {
            (Unit::Element(u), 0) => (*u).before(&content, ty),
            (Unit::Element(u), 1) => (*u).after(&content, ty),
            (Unit::Element(u), 2) => (*u).prepend(&content, ty),
            (Unit::Element(u), 3) => (*u).append(&content, ty),
            (Unit::Element(u), 4) => (*u).replace(&content, ty),
            (Unit::Element(u), 5) => (*u).set_inner_content(&content, ty),
            (Unit::Text(u), 0) => (*u).before(&content, ty),
            (Unit::Text(u), 1) => (*u).after(&content, ty),
            (Unit::Text(u), 4) => (*u).replace(&content, ty),
            (Unit::Comment(u), 0) => (*u).before(&content, ty),
            (Unit::Comment(u), 1) => (*u).after(&content, ty),
            (Unit::Comment(u), 4) => (*u).replace(&content, ty),
            (Unit::EndTag(u), 0) => (*u).before(&content, ty),
            (Unit::EndTag(u), 1) => (*u).after(&content, ty),
            (Unit::DocEnd(u), 3) => (*u).append(&content, ty),
            _ => return UNSUPPORTED,
        }
    }
    0
}

/// `remove()` of any unit but the document end.
#[unsafe(no_mangle)]
pub extern "C" fn unit_remove(id: u32) -> i32 {
    let Some(unit) = unit_of(id) else { return DETACHED };
    unsafe {
        match unit {
            Unit::Element(u) => (*u).remove(),
            Unit::Text(u) => (*u).remove(),
            Unit::Comment(u) => (*u).remove(),
            Unit::Doctype(u) => (*u).remove(),
            Unit::EndTag(u) => (*u).remove(),
            Unit::DocEnd(_) => return UNSUPPORTED,
        }
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn unit_removed(id: u32) -> i32 {
    let Some(unit) = unit_of(id) else { return DETACHED };
    unsafe {
        flag(match unit {
            Unit::Element(u) => (*u).removed(),
            Unit::Text(u) => (*u).removed(),
            Unit::Comment(u) => (*u).removed(),
            Unit::Doctype(u) => (*u).removed(),
            Unit::EndTag(u) => (*u).removed(),
            Unit::DocEnd(_) => return UNSUPPORTED,
        })
    }
}

// Element

#[unsafe(no_mangle)]
pub extern "C" fn el_remove_and_keep_content(id: u32) -> i32 {
    with!(id, Unit::Element(u) => { unsafe { (*u).remove_and_keep_content() }; 0 })
}

#[unsafe(no_mangle)]
pub extern "C" fn el_tag_name(id: u32) -> i32 {
    with!(id, Unit::Element(u) => ret(&unsafe { (*u).tag_name() }))
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn el_set_tag_name(id: u32, ptr: *const u8, len: usize) -> i32 {
    let name = unsafe { text(ptr, len) };
    with!(id, Unit::Element(u) => match unsafe { (*u).set_tag_name(&name) } {
        Ok(()) => 0,
        Err(e) => fail(e),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn el_namespace_uri(id: u32) -> i32 {
    with!(id, Unit::Element(u) => ret(unsafe { (*u).namespace_uri() }))
}

#[unsafe(no_mangle)]
pub extern "C" fn el_self_closing(id: u32) -> i32 {
    with!(id, Unit::Element(u) => flag(unsafe { (*u).is_self_closing() }))
}

#[unsafe(no_mangle)]
pub extern "C" fn el_can_have_content(id: u32) -> i32 {
    with!(id, Unit::Element(u) => flag(unsafe { (*u).can_have_content() }))
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn el_get_attribute(id: u32, ptr: *const u8, len: usize) -> i32 {
    // A name that isn't UTF-8 is never an attribute (Bun answers null for it as well).
    let Ok(name) = core::str::from_utf8(unsafe { bytes(ptr, len) }) else { return NULL };
    with!(id, Unit::Element(u) => ret_opt(unsafe { (*u).get_attribute(name) }))
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn el_has_attribute(id: u32, ptr: *const u8, len: usize) -> i32 {
    let name = unsafe { text(ptr, len) };
    with!(id, Unit::Element(u) => flag(unsafe { (*u).has_attribute(&name) }))
}

/// # Safety
/// The ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn el_set_attribute(id: u32, np: *const u8, nl: usize, vp: *const u8, vl: usize) -> i32 {
    let (name, value) = unsafe { (text(np, nl), text(vp, vl)) };
    with!(id, Unit::Element(u) => match unsafe { (*u).set_attribute(&name, &value) } {
        Ok(()) => 0,
        Err(e) => fail(e),
    })
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn el_remove_attribute(id: u32, ptr: *const u8, len: usize) -> i32 {
    let name = unsafe { text(ptr, len) };
    with!(id, Unit::Element(u) => { unsafe { (*u).remove_attribute(&name) }; 0 })
}

#[unsafe(no_mangle)]
pub extern "C" fn el_attribute_count(id: u32) -> i32 {
    with!(id, Unit::Element(u) => unsafe { (*u).attributes().len() as i32 })
}

/// The `index`th attribute as `name NUL value`, or `NULL` past the end.
#[unsafe(no_mangle)]
pub extern "C" fn el_attribute_at(id: u32, index: u32) -> i32 {
    with!(id, Unit::Element(u) => match unsafe { (*u).attributes().get(index as usize) } {
        Some(a) => ret(&format!("{}\0{}", a.name(), a.value())),
        None => NULL,
    })
}

/// `onEndTag`: runs `handler` (kind `END_TAG`) when the element's end tag comes. 0 registered; a positive handler
/// id means the element already has one registered by an earlier call (the host swaps that handler's callback, as
/// Bun does, one end tag callback per element); `ERR` for an element with no end tag.
#[unsafe(no_mangle)]
pub extern "C" fn el_on_end_tag(id: u32, rw: u32, handler: u32) -> i32 {
    with!(id, Unit::Element(u) => {
        let el = unsafe { &mut *u };
        if let Some(existing) = el.user_data().downcast_ref::<u32>().copied() {
            return existing as i32;
        }
        let Some(handlers) = el.end_tag_handlers() else { return fail("No end tag.") };
        handlers.push(Box::new(move |end_tag: &mut EndTag| {
            let end_tag = core::ptr::from_mut(end_tag).cast();
            dispatch(rw, handler, END_TAG, Unit::EndTag(end_tag))
        }));
        el.set_user_data(handler);
        0
    })
}

// Text chunk

#[unsafe(no_mangle)]
pub extern "C" fn text_get(id: u32) -> i32 {
    with!(id, Unit::Text(u) => ret(unsafe { (*u).as_str() }))
}

#[unsafe(no_mangle)]
pub extern "C" fn text_last_in_text_node(id: u32) -> i32 {
    with!(id, Unit::Text(u) => flag(unsafe { (*u).last_in_text_node() }))
}

// Comment

#[unsafe(no_mangle)]
pub extern "C" fn comment_get(id: u32) -> i32 {
    with!(id, Unit::Comment(u) => ret(&unsafe { (*u).text() }))
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn comment_set(id: u32, ptr: *const u8, len: usize) -> i32 {
    let value = unsafe { text(ptr, len) };
    with!(id, Unit::Comment(u) => match unsafe { (*u).set_text(&value) } {
        Ok(()) => 0,
        Err(e) => fail(e),
    })
}

// Doctype: `which` 0 name, 1 publicId, 2 systemId

#[unsafe(no_mangle)]
pub extern "C" fn doctype_get(id: u32, which: u32) -> i32 {
    with!(id, Unit::Doctype(u) => ret_opt(unsafe {
        match which {
            0 => (*u).name(),
            1 => (*u).public_id(),
            _ => (*u).system_id(),
        }
    }))
}

// End tag

#[unsafe(no_mangle)]
pub extern "C" fn end_tag_name(id: u32) -> i32 {
    with!(id, Unit::EndTag(u) => ret(&unsafe { (*u).name() }))
}

/// # Safety
/// The range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn end_tag_set_name(id: u32, ptr: *const u8, len: usize) -> i32 {
    let name = unsafe { text(ptr, len) }.into_owned();
    with!(id, Unit::EndTag(u) => { unsafe { (*u).set_name_str(name) }; 0 })
}
