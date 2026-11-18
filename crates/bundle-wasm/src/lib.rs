//! Bun's bundler (`bun_bundler::BundleV2`) behind a pointer+length C ABI, reading the file system
//! through `bun_sys` (host imports `bun_sys.*`, served by packages/vfs/sysHost.ts).
//!
//! Host flow: `alloc` the config JSON, call `bundle_c`, read the `Output` (JSON), then
//! `output_free` it and `dealloc` the input. The bundle runs single-threaded: the worker pool is
//! replaced by an inline queue (bun `threading: run scheduled tasks inline on wasm`).
//!
//! Config JSON (all optional except `entryPoints`):
//! `{cwd, entryPoints[], target: "browser"|"bun"|"node", format: "esm"|"cjs"|"iife", minify:
//!   bool | {whitespace, syntax, identifiers}, splitting, outdir, write (default false: outputs are returned in memory), external[], define{}, conditions[],
//!   sourcemap: "none"|"inline"|"external"|"linked", naming{entry,chunk,asset}, publicPath, banner, footer,
//!   loader{".ext": "js"|"jsx"|"ts"|"tsx"|"css"|"file"|"json"|"toml"|"wasm"|"napi"|"base64"|"dataurl"|"text"|"html"|..},
//!   packages: "bundle"|"external", drop[], rootDir, env: "inline"|"disable"|"PREFIX*" (`Bun.build`'s; "load-only" is the
//!   CLI's `--env=disable`), envVars{} (the process env: the wasm has none of its own),
//!   plugins: bool (the host's `bun_plugin.*` imports answer the plugin hooks, see plugins.rs)}`
//! Result JSON: `{success, outputs: [{path, kind, loader, inputLoader, hash, contents, encoding?}], logs: [{level,
//!   message, file, line, column}]}`. `contents` is text, or base64 with `encoding: "base64"` when the
//!   output isn't valid UTF-8 (images, wasm and other binary assets).

// The C/C++ stand-ins the parser and printer link against.
use bun_wasm_stubs as _;
// The bun_sys_host_* symbols bun_sys declares, as `bun_sys.*` wasm imports served by the VFS.
use bun_sys_host as _;
mod plugins;
mod stand_ins;
mod stubs;

use bun_bundler::bundle_v2::BundleV2;
use bun_bundler::transpiler::Transpiler;
use bun_options_types::schema::api;
use serde_json::{Value, json};

fn strs(v: &Value, key: &str) -> Vec<Box<[u8]>> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| Box::<[u8]>::from(s.as_bytes())).collect())
        .unwrap_or_default()
}

fn string(v: &Value, key: &str) -> Option<Box<[u8]>> {
    v.get(key).and_then(Value::as_str).map(|s| Box::<[u8]>::from(s.as_bytes()))
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn log_json(log: &bun_ast::Log) -> Vec<Value> {
    log.msgs
        .iter()
        .map(|m| {
            let (file, line, column) = match &m.data.location {
                Some(l) => (String::from_utf8_lossy(&l.file).into_owned(), l.line, l.column),
                None => (String::new(), 0, 0),
            };
            json!({
                "level": match m.kind {
                    bun_ast::Kind::Err => "error",
                    bun_ast::Kind::Warn => "warning",
                    bun_ast::Kind::Note => "note",
                    bun_ast::Kind::Debug => "debug",
                    bun_ast::Kind::Verbose => "verbose",
                },
                "message": String::from_utf8_lossy(&m.data.text),
                "file": file, "line": line, "column": column,
            })
        })
        .collect()
}

/// Runs a bundle described by `config` (see the module docs). Returns the result JSON.
pub fn bundle(config: &str) -> String {
    install_panic_hook();
    let cfg: Value = match serde_json::from_str(config) {
        Ok(v) => v,
        Err(e) => return json!({"success": false, "outputs": [], "logs": [{"level": "error", "message": format!("bad config: {e}")}]}).to_string(),
    };
    let cwd = string(&cfg, "cwd").unwrap_or_else(|| Box::from(&b"/"[..]));

    let mut log = Box::new(bun_ast::Log::init());
    let log_ptr: *mut bun_ast::Log = &mut *log;

    let mut args = api::TransformOptions::default();
    args.absolute_working_dir = Some(cwd.clone());
    args.entry_points = strs(&cfg, "entryPoints");
    args.external = strs(&cfg, "external");
    args.conditions = strs(&cfg, "conditions");
    args.target = Some(match cfg.get("target").and_then(Value::as_str) {
        Some("bun") => api::Target::bun,
        Some("node") => api::Target::node,
        _ => api::Target::browser,
    });
    args.source_map = Some(match cfg.get("sourcemap").and_then(Value::as_str) {
        Some("inline") => api::SourceMapMode::Inline,
        Some("external") => api::SourceMapMode::External,
        Some("linked") => api::SourceMapMode::Linked,
        _ => api::SourceMapMode::None,
    });
    if let Some(l) = cfg.get("loader").and_then(Value::as_object) {
        let (mut extensions, mut loaders) = (Vec::new(), Vec::new());
        for (ext, name) in l {
            if let Some(loader) = name.as_str().and_then(|n| bun_options_types::LOADER_API_NAMES.get(n.as_bytes()).copied()) {
                extensions.push(Box::<[u8]>::from(ext.as_bytes()));
                loaders.push(loader);
            }
        }
        args.loaders = Some(api::LoaderMap { extensions, loaders });
    }
    if cfg.get("packages").and_then(Value::as_str) == Some("external") {
        args.packages = Some(api::PackagesMode::External);
    }
    args.drop = strs(&cfg, "drop");
    if let Some(d) = cfg.get("define").and_then(Value::as_object) {
        args.define = Some(api::StringMap {
            keys: d.keys().map(|k| Box::<[u8]>::from(k.as_bytes())).collect(),
            values: d.values().map(|v| Box::<[u8]>::from(v.as_str().unwrap_or("").as_bytes())).collect(),
        });
    }

    let arena: &'static bun_alloc::Arena = Box::leak(Box::new(bun_alloc::Arena::new()));
    plugins::enable(flag(&cfg, "plugins"));
    let result = run(arena, log_ptr, args, &cfg);
    plugins::enable(false);
    let (success, outputs) = match result {
        Ok(o) => (true, o),
        Err(_) => (false, Vec::new()),
    };
    json!({"success": success && !log.has_errors(), "outputs": outputs, "logs": log_json(&log)}).to_string()
}

fn run(
    arena: &'static bun_alloc::Arena,
    log: *mut bun_ast::Log,
    args: api::TransformOptions,
    cfg: &Value,
) -> Result<Vec<Value>, bun_bundler::Error> {
    use bun_bundler::options;
    let t: &mut Transpiler<'static> = arena.alloc(Transpiler::init(arena, log, args, None)?);

    let min = cfg.get("minify");
    let (mw, ms, mi) = match min {
        Some(Value::Bool(b)) => (*b, *b, *b),
        Some(m @ Value::Object(_)) => (flag(m, "whitespace"), flag(m, "syntax"), flag(m, "identifiers")),
        _ => (false, false, false),
    };
    t.options.minify_whitespace = mw;
    t.options.minify_syntax = ms;
    t.options.minify_identifiers = mi;
    t.options.code_splitting = flag(cfg, "splitting");
    t.options.output_format = match cfg.get("format").and_then(Value::as_str) {
        Some("cjs") => options::Format::Cjs,
        Some("iife") => options::Format::Iife,
        _ => options::Format::Esm,
    };
    t.options.source_map = match cfg.get("sourcemap").and_then(Value::as_str) {
        Some("inline") => options::SourceMapOption::Inline,
        Some("external") => options::SourceMapOption::External,
        Some("linked") => options::SourceMapOption::Linked,
        _ => options::SourceMapOption::None,
    };
    let outdir = string(cfg, "outdir").unwrap_or_default();
    // `write: true` makes the bundler write the files into `outdir` itself (through the VFS) and the
    // outputs come back without contents; otherwise (the default) everything is returned in memory.
    t.options.supports_multiple_outputs = !outdir.is_empty() || flag(cfg, "splitting") || t.options.entry_points.len() > 1;
    // (`from_api` defaults `output_dir` to "out", which would make the bundler write.)
    t.options.output_dir = if flag(cfg, "write") { outdir } else { Box::default() };
    if let Some(p) = string(cfg, "publicPath") {
        t.options.public_path = p;
    }
    if let Some(b) = string(cfg, "banner") {
        t.options.banner = std::borrow::Cow::Owned(b.into_vec());
    }
    if let Some(b) = string(cfg, "footer") {
        t.options.footer = std::borrow::Cow::Owned(b.into_vec());
    }
    // The CLI's defaults (options_types/context.rs).
    t.options.entry_naming = Box::from(&b"[dir]/[name].[ext]"[..]);
    t.options.chunk_naming = Box::from(&b"./[name]-[hash].[ext]"[..]);
    t.options.asset_naming = Box::from(&b"./[name]-[hash].[ext]"[..]);
    let naming = cfg.get("naming");
    if let Some(n) = naming.and_then(|n| string(n, "entry")) {
        t.options.entry_naming = n;
    }
    if let Some(n) = naming.and_then(|n| string(n, "chunk")) {
        t.options.chunk_naming = n;
    }
    if let Some(n) = naming.and_then(|n| string(n, "asset")) {
        t.options.asset_naming = n;
    }
    // Root dir: nearest common directory of the entry points, as the CLI does.
    let entries: Vec<&[u8]> = t.options.entry_points.iter().map(|s| &**s).collect();
    let root: Box<[u8]> = match string(cfg, "rootDir") {
        Some(r) => r,
        None if entries.len() == 1 => bun_core::dirname(entries[0]).unwrap_or(b"/").into(),
        None => bun_paths_longest(&entries),
    };
    t.options.root_dir = root;
    t.options.no_macros = true;
    // `Bun.build`'s `env` (the CLI's `--env`); unset is `Disable`: nothing is read or inlined.
    let (behavior, prefix) = match cfg.get("env").and_then(Value::as_str) {
        // The CLI's `--env=disable`: .env files and the process env are loaded, nothing is inlined.
        Some("load-only") => (bun_dotenv::DotEnvBehavior::LoadAllWithoutInlining, &b""[..]),
        Some(e) => match bun_dotenv::DotEnvBehavior::parse_str(e.as_bytes()) {
            Ok((b, p)) => (b, p.unwrap_or(b"")),
            Err(()) => (bun_dotenv::DotEnvBehavior::Disable, &b""[..]),
        },
        None => (bun_dotenv::DotEnvBehavior::Disable, &b""[..]),
    };
    t.options.env.behavior = behavior;
    t.options.env.prefix = prefix.into();
    if let Some(vars) = cfg.get("envVars").and_then(Value::as_object) {
        let env = t.env_mut();
        for (k, v) in vars {
            if let Some(v) = v.as_str() {
                env.map.put(k.as_bytes(), v.as_bytes())?;
            }
        }
    }
    t.options.compile_mode = options::CompileMode::None;
    if !t.options.production {
        t.options.conditions.append_slice(&[b"development" as &[u8]])?;
    }
    t.configure_defines()?;
    t.configure_linker();
    t.sync_resolver_opts();

    let (mut reachable, mut dur, mut size) = (0usize, 0u64, 0u64);
    let mut event_loop = bun_event_loop::AnyEventLoop::init();
    let built = BundleV2::generate_from_cli(
        t,
        arena,
        Some(core::ptr::NonNull::from(&mut event_loop)),
        false,
        &mut reachable,
        &mut dur,
        &mut size,
        None,
    )?;
    Ok(built
        .output_files
        .iter()
        .map(|f| {
            use bun_bundler::output_file::Value;
            let (contents, value) = match &f.value {
                Value::Buffer { bytes } => (&bytes[..], "buffer"),
                Value::Saved(_) => (&[][..], "saved"),
                Value::Copy(_) => (&[][..], "copy"),
                Value::Noop => (&[][..], "noop"),
            };
            let kind: &'static str = f.output_kind.into();
            let mut o = json!({
                "path": String::from_utf8_lossy(&f.dest_path),
                "kind": kind,
                "loader": <&'static str>::from(f.loader),
                // What `BuildArtifact.loader` reports (output_file_jsc.rs): the entry point's loader for its chunks.
                "inputLoader": <&'static str>::from(f.input_loader),
                "hash": format!("{}", f.hash),
                "value": value,
            });
            match core::str::from_utf8(contents) {
                Ok(text) => o["contents"] = text.into(),
                Err(_) => {
                    // base64 output is ASCII
                    o["contents"] = String::from_utf8(bun_base64::encode_alloc(contents)).unwrap().into();
                    o["encoding"] = "base64".into();
                }
            }
            o
        })
        .collect())
}

fn bun_paths_longest(entries: &[&[u8]]) -> Box<[u8]> {
    // The longest common directory, by whole path components (`/src/css` for `/src/css/a.ts` and `/src/css/b.ts`).
    let mut it = entries.iter().map(|e| bun_core::dirname(e).unwrap_or(b"/"));
    let Some(first) = it.next() else { return Box::from(&b"/"[..]) };
    let mut common: Vec<&[u8]> = first.split(|c| *c == b'/').collect();
    for d in it {
        let n = common.iter().zip(d.split(|c| *c == b'/')).take_while(|(a, b)| *a == b).count();
        common.truncate(n);
    }
    let p = common.join(&b'/');
    if p.is_empty() { Box::from(&b"/"[..]) } else { p.into() }
}

#[repr(C)]
pub struct Output {
    /// 0 = ok, 1 = error (`ptr` is a message). Build failures are still status 0: see `success`.
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

fn into_output(status: u64, bytes: Vec<u8>) -> *mut Output {
    let mut bytes = bytes.into_boxed_slice();
    let (ptr, len) = (bytes.as_mut_ptr(), bytes.len());
    core::mem::forget(bytes);
    Box::into_raw(Box::new(Output { status, ptr, len }))
}

/// # Safety
/// `config` must be readable for `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bundle_c(config: *const u8, len: usize) -> *mut Output {
    let slice = if len == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(config, len) } };
    match core::str::from_utf8(slice) {
        Ok(s) => into_output(0, bundle(s).into_bytes()),
        Err(_) => into_output(1, b"config is not UTF-8".to_vec()),
    }
}

/// # Safety
/// `out` must come from `bundle_c`, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn output_free(out: *mut Output) {
    let out = unsafe { Box::from_raw(out) };
    if out.len != 0 {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.ptr, out.len)) });
    }
}

// panic=abort with no stderr: keep the message so the host can read it after the trap.
static PANIC_MESSAGE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Ok(mut m) = PANIC_MESSAGE.lock() {
                *m = info.to_string();
            }
        }));
    });
}

/// The last panic's message (the module traps right after). Free with `output_free`.
#[unsafe(no_mangle)]
pub extern "C" fn panic_message_c() -> *mut Output {
    into_output(1, PANIC_MESSAGE.lock().map(|m| m.clone().into_bytes()).unwrap_or_default())
}
