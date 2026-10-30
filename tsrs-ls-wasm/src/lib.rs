// tsrs's language service (TypeScript 7 ported to Rust) as a long-lived wasm32-wasip1 module: the host pushes the
// project's files in, then asks for hovers, completions and diagnostics. Built like tsrs's own tsrs_wasm (build.rs: its 80 MiB
// shadow stack), but on tsrs_ls directly: tsrs_project's Session spawns timer and queue threads, which a
// single-threaded module can't.
//
// ABI (one instance answers many requests; linear memory never shrinks, so the host replaces the instance when it
// has grown too much, and pushes the files again):
//   ls_input(len) -> ptr     a buffer of `len` bytes for the next request
//   ls_set_files()           request: `path \0 contents` pairs, NUL-separated (absolute paths)
//   ls_remove_files()        request: paths, NUL-separated
//   ls_hover()               request: `config \0 path \0 line \0 character` (UTF-16); reply: LSP Hover JSON or null
//   ls_completion()          request: `config \0 path \0 line \0 character \0 trigger` (trigger: the character typed,
//                            or empty when asked for); reply: LSP CompletionList JSON or null
//   ls_completion_resolve()  request: `config \0 item` (an item of that list, as JSON); reply: the item with its
//                            detail and documentation
//   ls_diagnostics()         request: `config \0 path`; reply: LSP Diagnostic[] JSON
//   ls_output() -> ptr, ls_output_len() -> len    the reply
// `config` is the tsconfig.json the program comes from. A program lives until a file changes; a change to one file
// of it reuses the rest (Program::update_program), and parsed files are cached by content across programs.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::fmt::Display;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use rustc_hash::FxHashMap;
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::P;
use tsrs_core::Tristate;
use tsrs_core::context::Context;
use tsrs_core::tspath::{Path, to_path};
use tsrs_lsproto as lsproto;
use tsrs_tsoptions::{self as tsoptions, ParseConfigHost, ParsedCommandLine};
use tsrs_vfs::vfstest::{self, MapFS};
use tsrs_vfs::{FS, bundled};

use tsrs_ls::autoimport::{ProjectID, Registry};
use tsrs_ls::lsconv::{self, Converters, compute_lsp_line_starts};
use tsrs_ls::lsutil::{UserPreferences, new_default_user_preferences};
use tsrs_ls::sourcemap::ECMALineInfo;
use tsrs_ls::{Host, LanguageService, new_language_service};

type MemFs = tsrs_vfs::iovfs::IoVFS<MapFS>;

/// Parsed files by name, parse options and content: a program rebuilt after an edit reparses only what changed.
/// The module is single-threaded; CompilerHost asks for Send + Sync.
struct CachingHost {
    inner: Arc<dyn CompilerHost>,
    cache: RefCell<FxHashMap<(SourceFileParseOptions, u64), Option<P<SourceFile>>>>,
}

unsafe impl Send for CachingHost {}
unsafe impl Sync for CachingHost {}

impl CompilerHost for CachingHost {
    fn fs(&self) -> &dyn FS {
        self.inner.fs()
    }
    fn default_library_path(&self) -> &str {
        self.inner.default_library_path()
    }
    fn get_current_directory(&self) -> &str {
        self.inner.get_current_directory()
    }
    fn trace(&self, msg: &'static tsrs_diagnostics::Message, args: &[&dyn Display]) {
        self.inner.trace(msg, args);
    }
    fn get_source_file(&self, opts: SourceFileParseOptions) -> Option<P<SourceFile>> {
        // Bundled libs never change; hash the rest.
        let hash = if bundled::is_bundled(&opts.file_name) {
            0
        } else {
            let mut h = DefaultHasher::new();
            self.inner.fs().read_file(&opts.file_name)?.hash(&mut h);
            h.finish()
        };
        let key = (opts, hash);
        if let Some(file) = self.cache.borrow().get(&key) {
            return *file;
        }
        let file = self.inner.get_source_file(key.0.clone());
        self.cache.borrow_mut().insert(key, file);
        file
    }
    fn get_content_mapped_source_files(
        &self,
        parse_options: SourceFileParseOptions,
        mapper: &tsrs_contentmapper::Mapper,
    ) -> Result<tsrs_contentmapper::SourceFiles, tsrs_contentmapper::Error> {
        self.inner.get_content_mapped_source_files(parse_options, mapper)
    }
    fn content_mapper_project(&self) -> Option<Arc<dyn tsrs_contentmapper::Project>> {
        self.inner.content_mapper_project()
    }
    fn get_resolved_project_reference(&self, file_name: &str, path: Path) -> Option<P<ParsedCommandLine>> {
        self.inner.get_resolved_project_reference(file_name, path)
    }
}

struct LsHost {
    fs: Arc<dyn FS>,
    converters: Arc<Converters>,
}

impl Host for LsHost {
    fn use_case_sensitive_file_names(&self) -> bool {
        true
    }
    fn read_file(&self, path: &str) -> Option<String> {
        self.fs.read_file(path)
    }
    fn converters(&self) -> Arc<Converters> {
        Arc::clone(&self.converters)
    }
    fn get_preferences(&self, _: &str) -> UserPreferences {
        // Completions for other modules' exports need an auto-import registry (`auto_import_registry`), which this
        // host doesn't build: without this, completing a name fails with "completion list needs auto imports".
        UserPreferences { include_completions_for_module_exports: Tristate::False, ..new_default_user_preferences() }
    }
    fn get_ecma_line_info(&self, _: &str) -> Option<Arc<ECMALineInfo>> {
        None
    }
    fn auto_import_registry(&self) -> Option<Arc<Registry>> {
        None
    }
    fn read_directory(&self, _: &str, _: &str, _: &[String], _: &[String], _: &[String], _: usize) -> Vec<String> {
        Vec::new()
    }
    fn get_directories(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
}

struct ConfigHost {
    fs: Arc<dyn FS>,
}

impl ParseConfigHost for ConfigHost {
    fn fs(&self) -> &dyn FS {
        &*self.fs
    }
    fn get_current_directory(&self) -> &'static str {
        "/"
    }
}

struct Project {
    config: String,
    program: &'static Program,
    ls: LanguageService,
}

struct State {
    mem: Arc<MemFs>,
    fs: Arc<dyn FS>,
    host: Arc<CachingHost>,
    ctx: Context,
    project: Option<Project>,
    /// Files changed since `project` was built; None once more changed than one program update covers.
    dirty: Option<Vec<String>>,
}

impl State {
    fn new() -> State {
        tsrs_compiler::worker_pool();
        let mem = Arc::new(vfstest::from_map(std::iter::empty::<(&str, &str)>(), true));
        let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(Arc::clone(&mem)));
        let inner = new_compiler_host("/", Arc::clone(&fs), &bundled::lib_path(), None, None, None);
        let host = Arc::new(CachingHost { inner, cache: RefCell::default() });
        let mut caps = lsproto::ResolvedClientCapabilities::default();
        caps.text_document.hover.content_format = vec![lsproto::MarkupKind::MARKDOWN];
        caps.text_document.completion.completion_item.documentation_format = vec![lsproto::MarkupKind::MARKDOWN];
        let ctx = lsproto::with_client_capabilities(&Context::background(), Arc::new(caps));
        State { mem, fs, host, ctx, project: None, dirty: Some(Vec::new()) }
    }

    fn changed(&mut self, path: &str) {
        // A config or package.json can change what every file means; so can a file appearing or going away, which
        // update_program also detects and answers with a full program.
        let structural = path.ends_with(".json");
        match &mut self.dirty {
            Some(list) if !structural => list.push(path.to_owned()),
            _ => self.dirty = None,
        }
    }

    fn set_file(&mut self, path: &str, text: &str) {
        if self.mem.read_file(path).as_deref() == Some(text) {
            return;
        }
        let _ = self.mem.write_file(path, text);
        self.changed(path);
    }

    fn remove_file(&mut self, path: &str) {
        if self.mem.remove(path).is_ok() {
            self.dirty = None;
        }
    }

    /// The language service for `config`'s program as the files are now.
    fn project(&mut self, config: &str) -> Option<&Project> {
        let current = self.project.as_ref().is_some_and(|p| p.config == config);
        let dirty = std::mem::replace(&mut self.dirty, Some(Vec::new()));
        if current && dirty.as_ref().is_some_and(Vec::is_empty) {
            return self.project.as_ref();
        }
        let program = match (&self.project, dirty.as_deref()) {
            // One file of the program changed: Program::update_program keeps the rest (or rebuilds when the
            // change touches imports).
            (Some(project), Some([path])) if current => {
                let (program, _, _) = project.program.update_program(
                    &to_path(path, "/", true),
                    Arc::<CachingHost>::clone(&self.host),
                    None,
                    None,
                );
                program
            }
            _ => {
                let config_host: &'static ConfigHost = Box::leak(Box::new(ConfigHost { fs: Arc::clone(&self.fs) }));
                let (command_line, _) =
                    tsoptions::get_parsed_command_line_of_config_file(config, None, None, config_host, None);
                new_program(ProgramOptions::new(P::new(command_line?), Arc::<CachingHost>::clone(&self.host)))
            }
        };
        let lines = Arc::clone(&self.fs);
        let converters = lsconv::new_converters(lsproto::PositionEncodingKind::UTF16, move |name| {
            lines.read_file(name).map(|text| compute_lsp_line_starts(&text))
        });
        let host = Arc::new(LsHost { fs: Arc::clone(&self.fs), converters });
        let ls = new_language_service(ProjectID(config.to_owned()), program, host, config);
        self.project = Some(Project { config: config.to_owned(), program, ls });
        self.project.as_ref()
    }
}

fn fields(request: &[u8]) -> Vec<String> {
    if request.is_empty() {
        return Vec::new();
    }
    request.split(|&b| b == 0).map(|f| String::from_utf8_lossy(f).into_owned()).collect()
}

fn json<T: lsproto::Json>(v: &T) -> String {
    tsrs_core::json::marshal(&v.to_json()).unwrap_or_else(|_| "null".into())
}

fn set_files(state: &mut State, request: &[u8]) {
    let fields = fields(request);
    for pair in fields.chunks_exact(2) {
        state.set_file(&pair[0], &pair[1]);
    }
}

fn remove_files(state: &mut State, request: &[u8]) {
    for path in fields(request) {
        state.remove_file(&path);
    }
}

fn hover(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, path, line, character] = f.as_slice() else { return "null".into() };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "null".into() };
    if project.program.get_source_file(path).is_none() {
        return "null".into();
    }
    let params = lsproto::HoverParams {
        text_document: lsproto::TextDocumentIdentifier { uri: lsconv::file_name_to_document_uri(path) },
        position: lsproto::Position { line: line.parse().unwrap_or(0), character: character.parse().unwrap_or(0) },
        ..Default::default()
    };
    project.ls.provide_hover(&ctx, &params).map_or_else(|_| "null".into(), |r| json(&r))
}

fn completion(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, path, line, character, trigger] = f.as_slice() else { return "null".into() };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "null".into() };
    if project.program.get_source_file(path).is_none() {
        return "null".into();
    }
    let uri = lsconv::file_name_to_document_uri(path);
    let position = lsproto::Position { line: line.parse().unwrap_or(0), character: character.parse().unwrap_or(0) };
    let context = lsproto::CompletionContext {
        trigger_kind: if trigger.is_empty() {
            lsproto::CompletionTriggerKind::INVOKED
        } else {
            lsproto::CompletionTriggerKind::TRIGGER_CHARACTER
        },
        trigger_character: (!trigger.is_empty()).then(|| trigger.clone()),
    };
    match project.ls.provide_completion(&ctx, &uri, position, Some(&context)) {
        Ok(lsproto::CompletionItemsOrListOrNull { list: Some(list), .. }) => json(&list),
        _ => "null".into(),
    }
}

fn completion_resolve(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, item] = f.as_slice() else { return "null".into() };
    let Some(item) = tsrs_core::json::unmarshal(item).ok().and_then(|v| <lsproto::CompletionItem as lsproto::Json>::from_json(&v).ok()) else {
        return "null".into();
    };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "null".into() };
    let data = item.data.clone();
    project.ls.resolve_completion_item(&ctx, item, data.as_ref()).map_or_else(|_| "null".into(), |r| json(&r))
}

fn diagnostics(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, path] = f.as_slice() else { return "[]".into() };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "[]".into() };
    if project.program.get_source_file(path).is_none() {
        return "[]".into();
    }
    let uri = lsconv::file_name_to_document_uri(path);
    let items = project
        .ls
        .provide_diagnostics(&ctx, &uri)
        .ok()
        .and_then(|r| r.full_document_diagnostic_report)
        .map(|r| r.items)
        .unwrap_or_default();
    let parts: Vec<String> = items.iter().map(json).collect();
    format!("[{}]", parts.join(","))
}

#[cfg(target_family = "wasm")]
mod abi {
    use std::cell::RefCell;

    use super::State;

    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
        static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    fn with(f: impl FnOnce(&mut State, &[u8]) -> String) {
        let request = INPUT.with_borrow_mut(std::mem::take);
        let reply = STATE.with_borrow_mut(|state| f(state.get_or_insert_with(State::new), &request));
        OUTPUT.with_borrow_mut(|output| *output = reply.into_bytes());
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_input(len: usize) -> *mut u8 {
        INPUT.with_borrow_mut(|input| {
            input.clear();
            input.resize(len, 0);
            input.as_mut_ptr()
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_set_files() {
        with(|state, request| {
            super::set_files(state, request);
            String::new()
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_remove_files() {
        with(|state, request| {
            super::remove_files(state, request);
            String::new()
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_hover() {
        with(super::hover);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_completion() {
        with(super::completion);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_completion_resolve() {
        with(super::completion_resolve);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_diagnostics() {
        with(super::diagnostics);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_output() -> *const u8 {
        OUTPUT.with_borrow(Vec::as_ptr)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_output_len() -> usize {
        OUTPUT.with_borrow(Vec::len)
    }
}
