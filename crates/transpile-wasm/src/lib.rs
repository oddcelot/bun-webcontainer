//! Bun's JS/TS/JSX transpiler (`bun_js_parser` + `bun_js_printer`) behind a pointer+length C ABI.
//!
//! Mirrors the no-bundle path of `bun_bundler::Transpiler` (`bundler/cache.rs` parse,
//! `print_ast_esm_ascii` print) without the resolver or macros. Defines and Bun's data loaders apply to
//! `Bun.Transpiler` only (`runtime`, `options_c`). `scan` reports the imports and exports of the same parse
//! (`Bun.Transpiler#scan`).

// The C/C++ stand-ins the parser and printer link against.
use bun_wasm_stubs as _;
// bun_sys declares bun_sys_host_* (syscalls); this crate never calls them, the stubs fail with ENOSYS.
use bun_sys_host as _;

use bun_alloc::Arena;
use bun_js_parser::{Define, Parser, ParserOptions, options};
use bun_js_printer as printer;

pub mod runtime;
use bun_ast::runtime::ReplaceableExportMap;
use runtime::Data;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Loader {
    Js,
    Jsx,
    Ts,
    Tsx,
    /// `json`, `toml`, `text`, ...: for `Bun.Transpiler`; never parsed as JS.
    Data(Data),
}

impl Loader {
    /// The `transpile_flags_c` loader number: 0 js, 1 jsx, 2 ts, 3 tsx, 4 json, 5 jsonc, 6 json5, 7 toml, 8 yaml,
    /// 9 xml, 10 text, 11 md.
    pub fn from_u32(n: u32) -> Option<Loader> {
        Some(match n {
            0 => Loader::Js,
            1 => Loader::Jsx,
            2 => Loader::Ts,
            3 => Loader::Tsx,
            4 => Loader::Data(Data::Json),
            5 => Loader::Data(Data::Jsonc),
            6 => Loader::Data(Data::Json5),
            7 => Loader::Data(Data::Toml),
            8 => Loader::Data(Data::Yaml),
            9 => Loader::Data(Data::Xml),
            10 => Loader::Data(Data::Text),
            11 => Loader::Data(Data::Md),
            _ => return None,
        })
    }
}

/// tsconfig `compilerOptions` that change the output, as bits of `transpile_flags_c`'s `flags`.
pub const EXPERIMENTAL_DECORATORS: u32 = 1;
pub const EMIT_DECORATOR_METADATA: u32 = 2;
/// Not a tsconfig option: on failure, `Output.ptr` holds the diagnostics as JSON (see `format_json`) instead of text.
pub const DIAGNOSTICS_JSON: u32 = 4;
/// Not a tsconfig option: output as `Bun.Transpiler` prints it (no JSX runtime import, no `/* @__PURE__ */`
/// annotations) instead of as `bun build --no-bundle`.
pub const RUNTIME_TRANSPILER: u32 = 8;
/// Not a tsconfig option: a file that uses a free `require` starts with `var {require}=import.meta;`, as Bun's printer
/// gives ES modules for its runtime (`bun build --no-bundle --target=bun`). Bun only does it for ES modules; with this
/// flag a file it would run as CommonJS gets it too, as the playground runs every transpiled file as an ES module.
pub const IMPORT_META_REQUIRE: u32 = 16;
/// `Bun.Transpiler` options (`minifyWhitespace`, `minify`, `trimUnusedImports`, `deadCodeElimination: false`,
/// `treeShaking`, `inline`), as Bun's runtime transpiler passes them to the parser and printer.
pub const MINIFY_WHITESPACE: u32 = 32;
pub const MINIFY_SYNTAX: u32 = 64;
pub const MINIFY_IDENTIFIERS: u32 = 128;
pub const TRIM_UNUSED_IMPORTS: u32 = 256;
pub const NO_DEAD_CODE_ELIMINATION: u32 = 512;
pub const TREE_SHAKING: u32 = 1024;
pub const INLINE: u32 = 2048;
/// For `module_kind`: the nearest package.json's `"type"` (`commonjs`, `module`; neither bit = no `"type"`).
pub const PACKAGE_TYPE_COMMONJS: u32 = 4096;
pub const PACKAGE_TYPE_MODULE: u32 = 8192;
/// Not a tsconfig option: an ES module as the body of a function of `hmr`, for the playground's synchronous
/// `require()` of one. Bun's dev-server (HMR) output: its exports become `hmr.exports = { ... }` (getters for live
/// bindings), `import.meta` `hmr.importMeta`, `import(x)` `hmr.dynamicImport(x)`, `require(x)` `hmr.require(x)` (a free
/// `require` otherwise is `hmr.importMeta.require`); its imports, which the dev server's linker turns into requires,
/// become `var ns = hmr.importSync("spec");` here, hoisted. A module with top-level await fails with Bun's error.
pub const SYNC_ESM: u32 = 16384;
/// Not a tsconfig option: the output is the JS, a NUL byte, then the source map's `mappings` (VLQ, one source,
/// lines and columns of the JS as returned, its first line's `require` declaration included).
pub const SOURCE_MAP: u32 = 32768;
/// `Bun.Transpiler`'s `target: "bun"`: printed as Bun's runtime prints for itself (the `IS_BUN` printer: ASCII-only
/// strings, `var {require}=import.meta;` in an ES module), `using` not lowered.
pub const TARGET_BUN: u32 = 65536;

/// tsconfig `compilerOptions` for JSX, as strings ("" = not set). Per-file pragmas still win.
#[derive(Clone, Default, Debug)]
pub struct Jsx {
    /// `jsx`: `react`, `react-jsx`, `react-jsxdev`, ... (`preserve` and unknown values are ignored, as in Bun).
    pub jsx: Vec<u8>,
    pub import_source: Vec<u8>,
    pub factory: Vec<u8>,
    pub fragment_factory: Vec<u8>,
}

impl Jsx {
    /// The four fields separated by NUL bytes (`jsx_c`'s format); missing trailing fields are unset.
    pub fn parse(bytes: &[u8]) -> Jsx {
        let mut it = bytes.split(|&b| b == 0).map(<[u8]>::to_vec);
        Jsx {
            jsx: it.next().unwrap_or_default(),
            import_source: it.next().unwrap_or_default(),
            factory: it.next().unwrap_or_default(),
            fragment_factory: it.next().unwrap_or_default(),
        }
    }

    /// The parser's pragma, as Bun's `TSConfigJSON` parse plus `merge_jsx` build it from the defaults.
    fn pragma(&self, production: bool) -> options::JSX::Pragma {
        use options::JSX::{Pragma, RUNTIME_MAP};
        let mut out = Pragma::default();
        // `BundleOptions::set_production`, before the tsconfig is merged.
        out.development = !production;
        if let Some(f) = Pragma::member_list_to_components_if_different(&out.factory, &self.factory) {
            out.factory = f;
        }
        if let Some(f) = Pragma::member_list_to_components_if_different(&out.fragment, &self.fragment_factory) {
            out.fragment = f;
        }
        if !self.jsx.is_empty() && self.jsx.len() <= 12 {
            if let Some(r) = RUNTIME_MAP.get(&self.jsx.to_ascii_lowercase()[..]) {
                out.runtime = r.runtime;
                if let Some(dev) = r.development {
                    out.development = dev;
                }
            }
        }
        if !self.import_source.is_empty() {
            // `merge_jsx` copies only `import_source` (not `package_name`).
            let mut p = Pragma::default();
            p.package_name = self.import_source.clone().into();
            p.set_import_source();
            out.import_source = p.import_source;
        }
        out
    }
}

thread_local! {
    /// Set by `jsx_c`; applies to every later call.
    static JSX: core::cell::RefCell<Jsx> = Default::default();
}

/// Transpiled JS on success; formatted diagnostics on failure.
pub fn transpile(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
    transpile_with(path, source, loader, flags, None)
}

/// Replaces an import record's specifier: `(specifier, kind)` -> `Some(new)` or `None` to keep it.
pub type Resolver<'r> = &'r mut dyn FnMut(&[u8], u32) -> Option<Vec<u8>>;

/// Record kinds passed to the resolver (`bun_ast::ImportKind`).
pub const KIND_STMT: u32 = 2;
pub const KIND_DYNAMIC: u32 = 4;

/// `transpile`, with each `import`/`export ... from`/`import("x")` specifier (from Bun's import records, so
/// never text inside strings, templates or comments) passed through `resolve` before printing.
/// `require()` and `require.resolve()` records are left alone.
pub fn transpile_with(path: &[u8], source: &[u8], loader: Loader, flags: u32, resolve: Option<Resolver>) -> Result<Vec<u8>, Vec<u8>> {
    with_ast(path, source, loader, flags, |mut ast, arena, src| {
        if flags & SYNC_ESM != 0 {
            if !ast.top_level_await_keyword.is_empty() {
                return Err(format!("require() async module \"{}\" is unsupported. use \"await import()\" instead.", String::from_utf8_lossy(path)).into_bytes());
            }
            hoist_imports_as_requires(&mut ast, arena);
        }
        if let Some(resolve) = resolve {
            for record in ast.import_records.iter_mut() {
                let kind = record.kind as u32;
                if (kind != KIND_STMT && kind != KIND_DYNAMIC) || record.flags.contains(bun_ast::ImportRecordFlags::IS_UNUSED) {
                    continue;
                }
                if let Some(new) = resolve(record.path.text, kind) {
                    record.path.text = arena.alloc_slice_copy(&new);
                }
            }
        }

        let symbols = bun_ast::symbol::Map::init_with_one_list(
            core::mem::replace(&mut ast.symbols, bun_alloc::ArenaVec::new_in(arena))
                .into_iter()
                .collect(),
        );
        let opts = printer::Options {
            bundling: false,
            require_ref: Some(ast.require_ref),
            import_meta_ref: ast.import_meta_ref,
            hmr_ref: ast.wrapper_ref,
            print_dce_annotations: flags & RUNTIME_TRANSPILER == 0,
            minify_whitespace: flags & MINIFY_WHITESPACE != 0,
            minify_syntax: flags & MINIFY_SYNTAX != 0,
            minify_identifiers: flags & MINIFY_IDENTIFIERS != 0,
            module_type: if flags & SYNC_ESM != 0 { options::bundle_enums::Format::InternalBakeDev } else { options::bundle_enums::Format::Esm },
            target: if flags & TARGET_BUN != 0 { bun_ast::Target::Bun } else { bun_ast::Target::Browser },
            ..Default::default()
        };
        // `uses_require_ref` means `require` is unbound, so the declaration never collides.
        let require: &[u8] = match () {
            _ if !ast.uses_require_ref || flags & TARGET_BUN != 0 => b"",
            _ if flags & SYNC_ESM != 0 => b"var require = hmr.importMeta.require;",
            _ if flags & IMPORT_META_REQUIRE != 0 => b"var {require}=import.meta;",
            _ => b"",
        };
        let mut writer = printer::BufferPrinter::init(printer::BufferWriter::init());
        if flags & SOURCE_MAP != 0 {
            let mut chunk: Option<bun_sourcemap::Chunk> = None;
            let printed = printer::print_ast::<_, false, true>(&mut writer, arena, &ast, symbols, src, printer::Options { source_map_handler: Some(printer::SourceMapHandler::for_(&mut chunk)), ..opts });
            return match printed {
                Ok(_) => {
                    let mappings = chunk.map(|c| c.buffer.list.to_vec()).unwrap_or_default();
                    Ok([require, writer.ctx.written(), b"\0", &shift_first_column(&mappings, require.len() as i64)].concat())
                }
                Err(e) => Err(format!("print failed: {e:?}").into_bytes()),
            };
        }
        let printed = if flags & TARGET_BUN != 0 {
            printer::print_ast::<_, true, false>(&mut writer, arena, &ast, symbols, src, opts)
        } else {
            printer::print_ast::<_, false, false>(&mut writer, arena, &ast, symbols, src, opts)
        };
        match printed {
            Ok(_) => Ok([require, writer.ctx.written()].concat()),
            Err(e) => Err(format!("print failed: {e:?}").into_bytes()),
        }
    })
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `mappings` with the generated column of the first line's first segment moved by `by` (the later segments are
/// relative to it): for text put before the printed code on its first line.
fn shift_first_column(mappings: &[u8], by: i64) -> Vec<u8> {
    if by == 0 || mappings.first().is_none_or(|&c| c == b';') {
        return mappings.to_vec();
    }
    // The first VLQ value: 5 bits per digit, continuation bit 32, sign in the lowest bit.
    let (mut value, mut shift, mut end) = (0i64, 0, 0);
    for (i, &c) in mappings.iter().enumerate() {
        let Some(digit) = BASE64.iter().position(|&b| b == c) else { return mappings.to_vec() };
        value |= ((digit & 31) as i64) << shift;
        shift += 5;
        if digit & 32 == 0 {
            end = i + 1;
            break;
        }
    }
    let column = if value & 1 != 0 { -(value >> 1) } else { value >> 1 } + by;
    let mut vlq = if column < 0 { ((-column) << 1) | 1 } else { column << 1 };
    let mut out = Vec::with_capacity(mappings.len() + 4);
    loop {
        let mut digit = (vlq & 31) as usize;
        vlq >>= 5;
        if vlq > 0 {
            digit |= 32;
        }
        out.push(BASE64[digit]);
        if vlq == 0 {
            break;
        }
    }
    out.extend_from_slice(&mappings[end..]);
    out
}

/// For `SYNC_ESM`: every import statement (left by the HMR transform, which rewrote the uses of its bindings as
/// `ns.name`) becomes `var ns = hmr.importSync("spec");` (a bare one `hmr.importSync("spec");`), in order at the top.
fn hoist_imports_as_requires<'a>(ast: &mut bun_ast::Ast<'a>, arena: &'a Arena) {
    use bun_ast::{Binding, E, Expr, ExprNodeList, G, S, Stmt, StmtData, b};
    use bun_collections::VecExt as _;
    let hmr = Expr::init_identifier(ast.wrapper_ref, bun_ast::Loc::EMPTY);
    let mut requires: Vec<Stmt> = Vec::new();
    for part in ast.parts.iter_mut() {
        let mut rest: Vec<Stmt> = Vec::new();
        for stmt in part.stmts.slice().iter() {
            let StmtData::SImport(st) = &stmt.data else {
                rest.push(*stmt);
                continue;
            };
            let record = &ast.import_records.as_slice()[st.import_record_index as usize];
            let call = Expr::init(
                E::Call {
                    target: Expr::init(E::Dot { target: hmr, name: b"importSync".into(), name_loc: stmt.loc, ..Default::default() }, stmt.loc),
                    args: ExprNodeList::from_slice(&[Expr::init(E::String { data: record.path.text.into(), ..Default::default() }, record.range.loc)]),
                    ..Default::default()
                },
                stmt.loc,
            );
            let bare = st.star_name_loc.is_empty() && st.items.len() == 0 && st.default_name.is_none();
            requires.push(if bare {
                Stmt::alloc(S::SExpr { value: call, ..Default::default() }, stmt.loc)
            } else {
                Stmt::alloc(
                    S::Local {
                        kind: bun_ast::LocalKind::KVar,
                        decls: G::DeclList::from_slice(&[G::Decl {
                            binding: Binding::alloc(arena, b::Identifier { r#ref: st.namespace_ref }, stmt.loc),
                            value: Some(call),
                        }]),
                        ..Default::default()
                    },
                    stmt.loc,
                )
            });
        }
        if rest.len() != part.stmts.slice().len() {
            part.stmts = bun_ast::StoreSlice::new_mut(arena.alloc_slice_copy(&rest));
        }
    }
    if let Some(first) = ast.parts.iter_mut().next() {
        requires.extend_from_slice(first.stmts.slice());
        first.stmts = bun_ast::StoreSlice::new_mut(arena.alloc_slice_copy(&requires));
    }
}

/// What `Bun.Transpiler#scan` reports, from the same parse as `transpile`:
/// `{"imports":[{"kind":"import-statement",..,"path":..}],"exports":[..]}`. The imports are the parser's import
/// records without internal ones and `require()` calls (as `named_imports_to_js` in Bun's `JSTranspiler.rs`, with
/// `trimUnusedImports` off), `kind` is `ImportKind::label`; the exports are the named exports, sorted.
pub fn scan(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
    with_ast(path, source, loader, flags, |ast, _, _| {
        let mut out = b"{\"imports\":[".to_vec();
        // Bun's `scan` never lists `require()` calls (its scan pass, `scan_imports`, does).
        // With `trimUnusedImports`, nor the imports the parser found unused (`named_imports_to_js`).
        let trim = flags & TRIM_UNUSED_IMPORTS != 0;
        let records = ast.import_records.iter().filter(|r| r.kind != bun_ast::ImportKind::Require);
        import_records_json(&mut out, records.filter(|r| !(trim && r.flags.contains(bun_ast::ImportRecordFlags::IS_UNUSED))));
        out.extend_from_slice(b"],\"exports\":[");
        let mut names: Vec<&[u8]> = ast.named_exports.keys().iter().map(|k| &**k).collect();
        names.sort_unstable();
        for (i, name) in names.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            json_str(&mut out, name);
        }
        out.extend_from_slice(b"]}");
        Ok(out)
    })
}

/// Whether Bun's runtime runs the file as CommonJS: `cjs` or `esm`. Parsed as Bun's runtime transpiler parses
/// (`commonjs_at_runtime`, the package's `"type"` as `module_type`, see `PACKAGE_TYPE_*`), its verdict is the module
/// loader's `is_commonjs_module`: an export or top-level await makes an ES module, a free `module`/`exports` (or
/// top-level `this`, `return`, `with`) CommonJS, else the package type decides; with none, an import statement means
/// ESM and a free `require`, `__dirname`, `__filename` or `"use strict"` CommonJS. The extension plays no part, as in
/// Bun. CommonJS features next to an import statement are Bun's error.
pub fn module_kind(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
    if let Loader::Data(_) = loader {
        return Ok(b"esm".to_vec());
    }
    with_ast_opts(path, source, loader, flags, true, |ast, _, _| {
        let cjs = ast.has_commonjs_export_names || ast.exports_kind == bun_ast::ExportsKind::Cjs;
        Ok(if cjs { b"cjs".to_vec() } else { b"esm".to_vec() })
    })
}

/// What `Bun.Transpiler#scanImports` reports: the import records of Bun's quick scan pass
/// (`Parser::scan_imports`, as `bun_bundler::cache::JavaScript::scan`), as `[{"kind":..,"path":..}]`.
pub fn scan_imports(path: &[u8], source: &[u8], loader: Loader, flags: u32) -> Result<Vec<u8>, Vec<u8>> {
    if let Loader::Data(_) = loader {
        return Err(b"Only JavaScript-like files support this fast path".to_vec());
    }
    let rt = runtime::Taken::take();
    let empty = Define::default();
    let define = rt.get().map_or(&empty, |r| &*r.define);
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();
    let src = bun_ast::Source::init_path_string(path, source);
    let mut log = bun_ast::Log::init();
    let mut result = bun_js_parser::ScanPassResult::init();
    let opts = parser_options(loader, flags, rt.get());
    let ok = Parser::init(opts, &mut log, &src, define, &arena).and_then(|mut p| p.scan_imports(&mut result)).is_ok();
    if !ok || log.errors > 0 {
        return Err(if flags & DIAGNOSTICS_JSON != 0 { format_json(&log) } else { format_log(&log) });
    }
    let mut out = b"[".to_vec();
    import_records_json(&mut out, result.import_records.iter());
    out.push(b']');
    Ok(out)
}

/// `{"kind":..,"path":..}` for each record but internal ones, comma-separated.
fn import_records_json<'r, 'a: 'r>(out: &mut Vec<u8>, records: impl Iterator<Item = &'r bun_ast::ImportRecord<'a>>) {
    let mut first = true;
    for record in records {
        if record.flags.contains(bun_ast::ImportRecordFlags::IS_INTERNAL) {
            continue;
        }
        if !first {
            out.push(b',');
        }
        first = false;
        out.extend_from_slice(b"{\"kind\":");
        json_str(out, record.kind.label());
        out.extend_from_slice(b",\"path\":");
        json_str(out, record.path.text);
        out.push(b'}');
    }
}

fn parser_options(loader: Loader, flags: u32, rt: Option<&runtime::Runtime>) -> ParserOptions<'static> {
    let loader = match loader {
        Loader::Js => bun_ast::Loader::Js,
        Loader::Jsx => bun_ast::Loader::Jsx,
        Loader::Ts => bun_ast::Loader::Ts,
        Loader::Tsx => bun_ast::Loader::Tsx,
        Loader::Data(_) => unreachable!("data loaders aren't parsed as JS"),
    };
    let mut opts = ParserOptions::init(JSX.with(|j| j.borrow().pragma(rt.is_some_and(|r| r.production))), loader);
    // As `bun build --no-bundle --target=browser` sets them (`bundler/transpiler.rs`).
    opts.features.auto_import_jsx = flags & RUNTIME_TRANSPILER == 0;
    opts.features.no_macros = true;
    opts.features.top_level_await = true;
    // JavaScriptCore runs `using` itself.
    opts.features.lower_using = flags & TARGET_BUN == 0;
    // As `bundler/transpiler.rs`: either tsconfig option means TypeScript's legacy decorators.
    let legacy = flags & (EXPERIMENTAL_DECORATORS | EMIT_DECORATOR_METADATA) != 0;
    opts.features.emit_decorator_metadata = flags & EMIT_DECORATOR_METADATA != 0;
    opts.features.standard_decorators = !loader.is_typescript() || !legacy;
    // `Bun.Transpiler`'s options, as `bundler/transpiler.rs` passes them on.
    opts.features.minify_syntax = flags & MINIFY_SYNTAX != 0;
    opts.features.minify_identifiers = flags & MINIFY_IDENTIFIERS != 0;
    opts.features.minify_whitespace = flags & MINIFY_WHITESPACE != 0;
    opts.features.dead_code_elimination = flags & NO_DEAD_CODE_ELIMINATION == 0;
    opts.features.trim_unused_imports = flags & TRIM_UNUSED_IMPORTS != 0;
    opts.features.inlining = flags & INLINE != 0;
    opts.tree_shaking = flags & TREE_SHAKING != 0;
    if flags & SYNC_ESM != 0 {
        opts.features.hot_module_reloading = true;
        opts.tree_shaking = false;
    }
    if let Some(rt) = rt {
        opts.features.replace_exports = ReplaceableExportMap { entries: rt.replace_exports.entries.clone().expect("OOM") };
    }
    opts
}

/// Parses `source` as `bun build --no-bundle --target=browser` does and hands the AST to `f`; parse errors are
/// formatted per `flags` (`DIAGNOSTICS_JSON`).
fn with_ast(
    path: &[u8],
    source: &[u8],
    loader: Loader,
    flags: u32,
    f: impl for<'a> FnOnce(bun_ast::Ast<'a>, &'a Arena, &bun_ast::Source) -> Result<Vec<u8>, Vec<u8>>,
) -> Result<Vec<u8>, Vec<u8>> {
    with_ast_opts(path, source, loader, flags, false, f)
}

/// `with_ast`; `runtime_module` parses for `module_kind`.
fn with_ast_opts(
    path: &[u8],
    source: &[u8],
    loader: Loader,
    flags: u32,
    runtime_module: bool,
    f: impl for<'a> FnOnce(bun_ast::Ast<'a>, &'a Arena, &bun_ast::Source) -> Result<Vec<u8>, Vec<u8>>,
) -> Result<Vec<u8>, Vec<u8>> {
    // Declared before the arena: the parser borrows the define table for as long as the AST lives.
    let rt = runtime::Taken::take();
    let empty = Define::default();
    let define = rt.get().map_or(&empty, |r| &*r.define);
    let arena = Arena::new();
    let mut ast_alloc = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_alloc.enter();

    let src = bun_ast::Source::init_path_string(path, source);
    let mut log = bun_ast::Log::init();

    let fail = |log: &bun_ast::Log| if flags & DIAGNOSTICS_JSON != 0 { format_json(log) } else { format_log(log) };
    if let Loader::Data(data) = loader {
        // As `Transpiler::parse`: an empty (or blank and short) file is an empty module, unless it's text.
        let blank = source.is_empty() || (source.len() < 33 && source.iter().all(|c| b"\n\r ".contains(c)));
        if blank && data != Data::Text {
            return f(bun_ast::Ast::empty_in(&arena), &arena, &src);
        }
        return match runtime::data_ast(data, &src, &mut log, &arena) {
            // `Bun.Transpiler` fails on warnings too (a duplicate JSON key).
            Some(ast) if log.errors == 0 && (flags & RUNTIME_TRANSPILER == 0 || log.warnings == 0) => f(ast, &arena, &src),
            _ => Err(fail(&log)),
        };
    }
    let mut opts = parser_options(loader, flags, rt.get());
    if runtime_module {
        // As the runtime's `ParseOptions { allow_commonjs: true, module_type, .. }` (`jsc_hooks.rs`).
        opts.features.commonjs_at_runtime = true;
        opts.module_type = if flags & PACKAGE_TYPE_COMMONJS != 0 {
            options::ModuleType::Cjs
        } else if flags & PACKAGE_TYPE_MODULE != 0 {
            options::ModuleType::Esm
        } else {
            options::ModuleType::Unknown
        };
    }
    let parsed = Parser::init(opts, &mut log, &src, define, &arena).and_then(|p| p.parse());
    let ast = match parsed {
        Ok(bun_js_parser::Result::Ast(ast)) if log.errors == 0 => ast,
        Ok(_) | Err(_) => return Err(fail(&log)),
    };
    f(*ast, &arena, &src)
}

fn format_log(log: &bun_ast::Log) -> Vec<u8> {
    let mut out = Vec::new();
    for msg in log.msgs.iter() {
        out.extend_from_slice(&msg.data.text);
        out.push(b'\n');
    }
    out
}

fn json_str(out: &mut Vec<u8>, s: &[u8]) {
    out.push(b'"');
    for ch in String::from_utf8_lossy(s).chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }
    out.push(b'"');
}

fn json_data(out: &mut Vec<u8>, d: &bun_ast::Data) {
    out.extend_from_slice(b"\"text\":");
    json_str(out, &d.text);
    match &d.location {
        // `line` and `column` are 1-based (Bun's `Location.column` doc says 0-based but the parser emits 1-based), `length` is 0 for "one character"; `column` and `length` count UTF-8 bytes.
        Some(l) if l.line > 0 => {
            out.extend_from_slice(format!(",\"line\":{},\"column\":{},\"length\":{}", l.line, l.column, l.length).as_bytes())
        }
        _ => {}
    }
}

/// `{"diagnostics":[{"severity":"error"|"warning","text":..,"line"?:..,"column"?:..,"length"?:..,"notes":[{"text":..,"line"?..}]}]}`
/// for the messages of `Kind::Err`/`Kind::Warn` (notes and debug/verbose messages are skipped as top-level entries).
fn format_json(log: &bun_ast::Log) -> Vec<u8> {
    let mut out = b"{\"diagnostics\":[".to_vec();
    let mut first = true;
    for msg in log.msgs.iter() {
        let severity: &[u8] = match msg.kind {
            bun_ast::Kind::Err => b"error",
            bun_ast::Kind::Warn => b"warning",
            _ => continue,
        };
        if !first {
            out.push(b',');
        }
        first = false;
        out.extend_from_slice(b"{\"severity\":\"");
        out.extend_from_slice(severity);
        out.extend_from_slice(b"\",");
        json_data(&mut out, &msg.data);
        out.extend_from_slice(b",\"notes\":[");
        for (i, note) in msg.notes.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.push(b'{');
            json_data(&mut out, note);
            out.push(b'}');
        }
        out.extend_from_slice(b"]}");
    }
    out.extend_from_slice(b"]}");
    out
}

// ── C ABI ──
//
// Host flow: `alloc` input buffers, write UTF-8, call `transpile`, read the `Output` it returns,
// then `output_free` it and `dealloc` the inputs.

#[repr(C)]
pub struct Output {
    /// 0 = ok (`ptr` is JS), 1 = error (`ptr` is diagnostics), 2 = bad loader.
    pub status: u64,
    pub ptr: *mut u8,
    pub len: usize,
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
) -> *mut Output {
    unsafe { transpile_flags_c(path, path_len, src, src_len, loader, 0) }
}

/// `transpile_c` with tsconfig flags (`EXPERIMENTAL_DECORATORS`, `EMIT_DECORATOR_METADATA`) and `DIAGNOSTICS_JSON`.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_flags_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    unsafe { run(path, path_len, src, src_len, loader, flags, None) }
}

unsafe fn run(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
    resolve: Option<Resolver>,
) -> *mut Output {
    unsafe { run_with(path, path_len, src, src_len, loader, |path, src, loader| transpile_with(path, src, loader, flags, resolve)) }
}

unsafe fn run_with(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    f: impl FnOnce(&[u8], &[u8], Loader) -> Result<Vec<u8>, Vec<u8>>,
) -> *mut Output {
    let slice = |p: *const u8, n: usize| if n == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(p, n) } };
    let Some(loader) = Loader::from_u32(loader) else {
        return Box::into_raw(Box::new(Output { status: 2, ptr: core::ptr::null_mut(), len: 0 }));
    };
    let (status, bytes) = match f(slice(path, path_len), slice(src, src_len), loader) {
        Ok(b) => (0, b),
        Err(b) => (1, b),
    };
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

/// `scan` (imports and exports as JSON, see there) behind the `transpile_flags_c` ABI.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    unsafe { run_with(path, path_len, src, src_len, loader, |path, src, loader| scan(path, src, loader, flags)) }
}

/// `module_kind` (`cjs` or `esm`, see there) behind the `transpile_flags_c` ABI.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn module_kind_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    unsafe { run_with(path, path_len, src, src_len, loader, |path, src, loader| module_kind(path, src, loader, flags)) }
}

/// `scan_imports` (JSON, see there) behind the `transpile_flags_c` ABI.
///
/// # Safety
/// Both input ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_imports_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    unsafe { run_with(path, path_len, src, src_len, loader, |path, src, loader| scan_imports(path, src, loader, flags)) }
}

// ── Host resolver ABI (`transpile_resolve_c`) ──
//
// The module imports `env.resolve_specifier(ptr: usize, len: usize, kind: u32) -> usize` (usize = i64 on wasm64).
// `ptr`/`len` is the UTF-8 specifier as written, valid only during the call; `kind` is 2 (static import or
// `export ... from`) or 4 (`import("literal")`). The host returns 0 to keep it, or a pointer from this module's
// `alloc(8 + n)` holding `n` as a little-endian u64 followed by `n` bytes of UTF-8 replacement. The transpiler
// copies the bytes and frees the buffer. Memory may grow during `alloc`, so the host must re-view `memory.buffer`.
#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    #[link_name = "resolve_specifier"]
    fn host_resolve_specifier(ptr: *const u8, len: usize, kind: u32) -> usize;
}
#[cfg(not(target_family = "wasm"))]
unsafe fn host_resolve_specifier(_: *const u8, _: usize, _: u32) -> usize {
    0
}

/// `transpile_flags_c` that rewrites import specifiers through the host's `env.resolve_specifier`.
///
/// # Safety
/// Both input ranges must be readable; the host import must follow the ABI above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn transpile_resolve_c(
    path: *const u8,
    path_len: usize,
    src: *const u8,
    src_len: usize,
    loader: u32,
    flags: u32,
) -> *mut Output {
    let mut host = |spec: &[u8], kind: u32| -> Option<Vec<u8>> {
        let p = unsafe { host_resolve_specifier(spec.as_ptr(), spec.len(), kind) };
        if p == 0 {
            return None;
        }
        let n = unsafe { core::ptr::read_unaligned(p as *const u64) } as usize;
        let out = unsafe { core::slice::from_raw_parts((p + 8) as *const u8, n) }.to_vec();
        unsafe { dealloc(p as *mut u8, 8 + n) };
        Some(out)
    };
    unsafe { run(path, path_len, src, src_len, loader, flags, Some(&mut host)) }
}

/// Sets the tsconfig JSX options (`Jsx::parse`'s format) for every later call; an empty input resets them.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jsx_c(ptr: *const u8, len: usize) {
    let bytes = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(ptr, len) } };
    JSX.with(|j| *j.borrow_mut() = Jsx::parse(bytes));
}

/// Sets `Bun.Transpiler`'s define table and export replacements (`runtime::fields`' format) for every later call; an
/// empty input resets them. Returns an `Output`: status 0, or 1 with the define values' parse errors (JSON, as
/// `DIAGNOSTICS_JSON`), which leaves the previous options in place.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn options_c(ptr: *const u8, len: usize) -> *mut Output {
    let bytes = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(ptr, len) } };
    let (status, mut bytes) = match runtime::set(bytes) {
        Ok(()) => (0, Box::<[u8]>::default()),
        Err(log) => (1, format_json(&log).into_boxed_slice()),
    };
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

/// # Safety
/// `out` must come from `transpile_c`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn output_free(out: *mut Output) {
    let out = unsafe { Box::from_raw(out) };
    if !out.ptr.is_null() {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.ptr, out.len)) });
    }
}
