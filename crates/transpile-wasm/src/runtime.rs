//! What `Bun.Transpiler` adds to a transpile: its `define` table and `exports` (`options_c`), and the data loaders
//! (`json`, `toml`, `yaml`, …) `transformSync(code, loader)` takes.
//!
//! Bun builds the define table in `bun_bundler` (`options::defines_from_transform_options`, `defines.rs`), which this
//! crate doesn't link; `parse_define` and `define_table` are those functions for the inputs `Bun.Transpiler` gives
//! them (the user's `define` plus the `process.env.NODE_ENV`/`BUN_ENV`/`process.browser` defaults, no env file).

use bun_alloc::Arena;
use bun_ast::{E, ExprData, Ref};
use bun_ast::runtime::{ReplaceableExport, ReplaceableExportMap};
use bun_js_parser::defines::{Define, DefineData, Flags, Options as DefineOptions};
use bun_js_parser::defines_table::{GLOBAL_NO_SIDE_EFFECT_FUNCTION_CALLS_SAFE_FOR_TO_STRING, GLOBAL_NO_SIDE_EFFECT_PROPERTY_ACCESSES};
use bun_js_parser::lexer as js_lexer;

/// `Bun.Transpiler`'s define table and export replacements, as `options_c` set them.
pub struct Runtime {
    /// The `options_c` input these were built from.
    key: Vec<u8>,
    pub define: Box<Define>,
    pub replace_exports: ReplaceableExportMap,
    /// `process.env.NODE_ENV` is "production" (Bun's `set_production`: the JSX runtime defaults to `jsx`, not `jsxDEV`).
    pub production: bool,
    /// Holds the define and replacement values; declared last so it outlives them.
    _arena: Box<Arena>,
}

thread_local! {
    /// Set by `options_c`; applies to every later call until reset.
    pub static RUNTIME: core::cell::RefCell<Option<Runtime>> = const { core::cell::RefCell::new(None) };
}

/// The current `Runtime`, taken out of `RUNTIME` for one call (so the parser can borrow it for the call's lifetime)
/// and put back on drop.
pub struct Taken(Option<Runtime>);

impl Taken {
    pub fn take() -> Taken {
        Taken(RUNTIME.with(|r| r.borrow_mut().take()))
    }
    pub fn get(&self) -> Option<&Runtime> {
        self.0.as_ref()
    }
}

impl Drop for Taken {
    fn drop(&mut self) {
        let rt = self.0.take();
        RUNTIME.with(|r| *r.borrow_mut() = rt);
    }
}

/// The `options_c` input: records of length-prefixed fields (`u32` little-endian length, then the bytes). Each record
/// is a one-byte tag field and then its fields:
/// - `d` key value: a define, as Bun takes it (a JSON value, an identifier path, or else a string)
/// - `e` name: `exports.eliminate`
/// - `r` name value: `exports.replace` with a value (`value_expr`'s format)
/// - `i` name inject value: `exports.replace` with `[inject, value]`
/// - `P`: the environment's `NODE_ENV` is "production"
fn fields(mut bytes: &[u8]) -> Option<Vec<&[u8]>> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let n = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        out.push(bytes.get(4..4 + n)?);
        bytes = &bytes[4 + n..];
    }
    Some(out)
}

/// Builds `Runtime` from `options_c`'s input (see `fields`), or reuses the current one if the input is the same. An
/// empty input resets it. Err: the define values' parse errors.
pub fn set(bytes: &[u8]) -> Result<(), bun_ast::Log> {
    if bytes.is_empty() {
        RUNTIME.with(|r| *r.borrow_mut() = None);
        return Ok(());
    }
    if RUNTIME.with(|r| r.borrow().as_ref().is_some_and(|r| r.key == bytes)) {
        return Ok(());
    }
    let Some(fields) = fields(bytes) else {
        let mut log = bun_ast::Log::init();
        log.add_error_fmt(None, bun_ast::Loc::EMPTY, format_args!("malformed Bun.Transpiler options"));
        return Err(log);
    };
    let arena = Box::new(Arena::new());
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let scope = ast_alloc.enter();
    let mut log = bun_ast::Log::init();
    let mut defines: Vec<(&[u8], DefineData)> = Vec::new();
    let mut replace_exports = ReplaceableExportMap::default();
    let mut production = false;
    let mut it = fields.into_iter();
    let malformed = |log: &mut bun_ast::Log| log.add_error_fmt(None, bun_ast::Loc::EMPTY, format_args!("malformed Bun.Transpiler options"));
    while let Some(tag) = it.next() {
        match tag {
            b"d" => {
                let (Some(key), Some(value)) = (it.next(), it.next()) else { malformed(&mut log); break };
                match parse_define(key, value, &mut log, &arena) {
                    Some(data) => defines.push((key, data)),
                    None => break,
                }
            }
            b"e" => {
                let Some(name) = it.next() else { malformed(&mut log); break };
                let _ = replace_exports.entries.put(name, ReplaceableExport::Delete);
            }
            b"r" => {
                let (Some(name), Some(Some(value))) = (it.next(), it.next().map(|v| value_expr(v, &arena))) else { malformed(&mut log); break };
                let _ = replace_exports.entries.put(name, ReplaceableExport::Replace(value));
            }
            b"i" => {
                let (Some(name), Some(inject), Some(Some(value))) = (it.next(), it.next(), it.next().map(|v| value_expr(v, &arena))) else {
                    malformed(&mut log);
                    break;
                };
                let _ = replace_exports.entries.put(name, ReplaceableExport::Inject { name: inject.into(), value });
            }
            b"P" => production = true,
            _ => {
                malformed(&mut log);
                break;
            }
        }
    }
    if log.errors > 0 {
        return Err(log);
    }
    let define = define_table(defines);
    // As `configure_defines`: an explicit "development" wins over the environment, "production" from either sets it.
    match define.dots_for(b"NODE_ENV").and_then(|d| d.iter().find(|d| d.parts.iter().map(|p| &**p).eq([&b"process"[..], b"env", b"NODE_ENV"]))) {
        Some(d) => match d.data.value.e_string() {
            Some(s) if s.eql_comptime(b"production") => production = true,
            Some(s) if s.eql_comptime(b"development") => production = false,
            _ => {}
        },
        None => {}
    }
    drop(scope);
    drop(ast_alloc);
    RUNTIME.with(|r| *r.borrow_mut() = Some(Runtime { key: bytes.to_vec(), define, replace_exports, production, _arena: arena }));
    Ok(())
}

/// An `exports.replace` value: `s` + UTF-8 (string), `n` + a JS number's text, `b1`/`b0`, `l` (null), `u` (undefined).
fn value_expr(v: &[u8], arena: &Arena) -> Option<bun_ast::Expr> {
    let loc = bun_ast::Loc::EMPTY;
    let data = match *v.first()? {
        b's' => return Some(bun_ast::Expr::allocate(arena, E::EString::init(arena.alloc_slice_copy(&v[1..])), loc)),
        b'n' => ExprData::ENumber(E::Number::new(core::str::from_utf8(&v[1..]).ok()?.parse().ok()?)),
        b'b' => ExprData::EBoolean(E::Boolean { value: v.get(1) == Some(&b'1') }),
        b'l' => ExprData::ENull(E::Null {}),
        b'u' => ExprData::EUndefined(E::Undefined {}),
        _ => return None,
    };
    Some(bun_ast::Expr { data, loc })
}

/// `DefineData::parse` (bun_bundler `defines.rs`) for a user define (not valueless, no `drop`). None after logging an
/// error. Invalid keys are logged by Bun but not fatal (`Bun.Transpiler` ignores them), so they're accepted here.
fn parse_define(_key: &[u8], value: &[u8], log: &mut bun_ast::Log, arena: &Arena) -> Option<DefineData> {
    let original_name = (!value.is_empty()).then(|| Box::<[u8]>::from(value));
    let is_ident = value.split(|&b| b == b'.').all(|part| js_lexer::is_identifier(part) && js_lexer::keyword(part).is_none());
    if is_ident {
        let value = if value == b"undefined" {
            ExprData::EUndefined(E::Undefined)
        } else {
            ExprData::EIdentifier(E::Identifier::init(Ref::NONE).with_can_be_removed_if_unused(true))
        };
        return Some(DefineData { value, original_name, flags: Flags::new(false, true, E::CallUnwrap::Never, false) });
    }
    let path = {
        let mut p = bun_paths::fs::Path::init(b"defines.json");
        p.namespace = b"internal";
        p
    };
    let contents: &[u8] = arena.alloc_slice_copy(value);
    let source = bun_ast::Source { contents: std::borrow::Cow::Borrowed(contents), path, ..Default::default() };
    let expr = bun_parsers::json_parser::parse_env_json(&source, log, arena).ok()?;
    let mut expr = bun_parsers::json_parser::clone_out_of_store(&expr, &source, log, arena).ok()?;
    clear_locs(&mut expr);
    let removable = bun_ast::expr::Tag::is_primitive_literal(expr.data.tag());
    Some(DefineData { value: expr.data, original_name, flags: Flags::new(false, removable, E::CallUnwrap::Never, false) })
}

/// The positions are in the text of the define, and the printer takes them for ones in the file (`defines.rs`).
fn clear_locs(expr: &mut bun_ast::Expr) {
    expr.loc = bun_ast::Loc::EMPTY;
    match expr.data {
        ExprData::EObject(mut object) => {
            object.close_brace_loc = bun_ast::Loc::EMPTY;
            for property in object.properties.iter_mut() {
                if let Some(key) = &mut property.key {
                    clear_locs(key);
                }
                if let Some(value) = &mut property.value {
                    clear_locs(value);
                }
            }
        }
        ExprData::EArray(mut array) => {
            array.close_bracket_loc = bun_ast::Loc::EMPTY;
            array.items.iter_mut().for_each(clear_locs);
        }
        _ => {}
    }
}

/// `Define::init` (bun_bundler `defines.rs`): the side-effect-free globals, then the user's defines in order. Calls to
/// the to-string-safe globals aren't unwrapped (`omit_unused_global_calls` needs `minify_syntax` and DCE, which
/// `Bun.Transpiler` passes as false: its `BundleOptions` have `minify_syntax` unset when the define table is built).
fn define_table(user: Vec<(&[u8], DefineData)>) -> Box<Define> {
    let mut define = Box::new(Define::default());
    define.dots.reserve(124);
    let global = DefineData::init(DefineOptions {
        value: ExprData::EUndefined(E::Undefined),
        valueless: true,
        can_be_removed_if_unused: true,
        ..Default::default()
    });
    for parts in GLOBAL_NO_SIDE_EFFECT_PROPERTY_ACCESSES.iter().chain(GLOBAL_NO_SIDE_EFFECT_FUNCTION_CALLS_SAFE_FOR_TO_STRING.iter()) {
        let key = parts[parts.len() - 1];
        define.dots_filter.insert(key);
        let dot = bun_js_parser::defines::DotDefine { parts: parts.iter().map(|p| Box::<[u8]>::from(*p)).collect(), data: global.clone() };
        match define.dots.get_mut(key) {
            Some(existing) => existing.push(dot),
            None => define.dots.put_assume_capacity(key, vec![dot]),
        }
    }
    for (key, data) in user {
        let _ = define.insert(key, data);
    }
    define
}

/// Bun's data loaders (`Bun.Transpiler#transformSync(code, loader)`), by `transpile_flags_c` loader number.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Data {
    Json,
    Jsonc,
    Json5,
    Toml,
    Yaml,
    Xml,
    Text,
}

/// The module `bundler/transpiler.rs` (`parse_data_loader`, `parse_text_loader`) makes of a data file: `export default`
/// the value, and for an object also a `var` and named export per string key (not "default"). None after logging an
/// error.
pub fn data_ast<'a>(loader: Data, source: &'a bun_ast::Source<'a>, log: &mut bun_ast::Log, arena: &'a Arena) -> Option<bun_ast::Ast<'a>> {
    use bun_parsers as p;
    let export_default = |expr: bun_ast::Expr| {
        bun_ast::Stmt::alloc(
            bun_ast::S::ExportDefault {
                value: bun_ast::StmtOrExpr::Expr(expr),
                default_name: bun_ast::LocRef { loc: bun_ast::Loc::default(), ref_: Ref::NONE },
            },
            bun_ast::Loc { start: 0 },
        )
    };
    let part = |stmts: &[bun_ast::Stmt]| -> Box<[bun_ast::Part]> {
        Box::new([bun_ast::Part { stmts: bun_ast::StoreSlice::new_mut(arena.alloc_slice_copy(stmts)), ..Default::default() }])
    };
    let mut expr = match loader {
        Data::Text => {
            let expr = bun_ast::Expr::init(E::EString::init(&source.contents), bun_ast::Loc::EMPTY);
            return Some(bun_ast::Ast::from_parts(part(&[export_default(expr)]), arena));
        }
        Data::Json => p::json::parse_json_into_arena(source, log, arena).ok()?,
        Data::Jsonc => p::json::parse_jsonc_into_arena(source, log, arena).ok()?,
        Data::Json5 => p::json5::JSON5Parser::parse(source, log, arena).ok()?,
        Data::Toml => p::toml::TOML::parse(source, log, arena, false).ok()?,
        Data::Yaml => p::yaml::YAML::parse(source, log, arena, p::yaml::CyclicAliases::Reject).ok()?,
        Data::Xml => {
            let options = p::xml::Options { compact: true, encoding: p::xml::InputEncoding::File };
            p::xml::XML::parse(source, log, arena, options).ok()?
        }
    };
    if matches!(expr.data, ExprData::EObjectJSON(_) | ExprData::EArrayJSON(_)) {
        expr = p::json::materialize(&expr, source, log, arena).ok()?;
    }

    let mut symbols: Vec<bun_ast::Symbol> = Vec::new();
    let mut parts = None;
    if let Some(obj) = expr.data.e_object_mut() {
        let properties: &mut [bun_ast::G::Property] = &mut obj.properties[..];
        let n = properties.len();
        let mut decls: Vec<bun_ast::G::Decl> = Vec::with_capacity(n);
        let export_clauses = arena.alloc_slice_fill_default::<bun_ast::ClauseItem>(n);
        let mut seen: std::collections::HashMap<Vec<u8>, usize> = Default::default();
        for prop in properties.iter_mut() {
            let key = prop.key.as_mut().unwrap();
            let key_loc = key.loc;
            // No named exports for YAML or JSON5 keys that aren't strings.
            let Some(key_string) = key.data.e_string_mut() else { continue };
            let name: &[u8] = key_string.slice(arena);
            if name == b"default" {
                continue;
            }
            let value = prop.value.expect("a property of a data file has a value");
            if let Some(&i) = seen.get(name) {
                decls[i].value = Some(value);
                continue;
            }
            let count = decls.len();
            seen.insert(name.to_vec(), count);
            let identifier = bun_core::MutableString::ensure_valid_identifier(name).ok()?;
            symbols.push(bun_ast::Symbol { original_name: bun_ast::StoreStr::new(arena.alloc_slice_copy(&identifier)), ..Default::default() });
            let ref_ = Ref::init(count as u32, 0, false);
            decls.push(bun_ast::G::Decl { binding: bun_ast::Binding::alloc(arena, bun_ast::b::Identifier { r#ref: ref_ }, key_loc), value: Some(value) });
            export_clauses[count] = bun_ast::ClauseItem {
                name: bun_ast::LocRef { ref_, loc: key_loc },
                alias: bun_ast::StoreStr::new(name),
                alias_loc: key_loc,
                ..Default::default()
            };
            prop.value = Some(bun_ast::Expr::init_identifier(ref_, value.loc));
        }
        // `print_decls` aborts on a `var` with no declarations (`{"default": 1}`).
        let count = decls.len();
        if count > 0 {
            let local = bun_ast::Stmt::alloc(
                bun_ast::S::Local { decls: <bun_ast::G::DeclList as bun_collections::vec_ext::VecExt<_>>::move_from_list(decls), kind: bun_ast::S::Kind::KVar, ..Default::default() },
                bun_ast::Loc { start: 0 },
            );
            let clause = bun_ast::Stmt::alloc(
                bun_ast::S::ExportClause { items: bun_ast::StoreSlice::new_mut(&mut export_clauses[..count]), is_single_line: false },
                bun_ast::Loc { start: 0 },
            );
            parts = Some(part(&[local, clause, export_default(expr)]));
        }
    }
    let mut ast = bun_ast::Ast::from_parts(parts.unwrap_or_else(|| part(&[export_default(expr)])), arena);
    ast.symbols = bun_alloc::vec_from_iter_in(symbols, arena);
    Some(ast)
}
