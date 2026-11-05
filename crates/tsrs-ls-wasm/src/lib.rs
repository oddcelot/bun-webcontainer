// tsrs's language service (TypeScript 7 ported to Rust) as a long-lived wasm32-wasip1 module: the host pushes the
// project's files in, then asks for hovers, completions, signature help, definitions and diagnostics. Built like tsrs's own tsrs_wasm (build.rs: its 80 MiB
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
//   ls_signature_help()      request: `config \0 path \0 line \0 character \0 trigger \0 retrigger` (trigger: the
//                            character typed, or empty; retrigger: "1" while hints are showing); reply: LSP
//                            SignatureHelp JSON or null
//   ls_definition()          request: `config \0 path \0 line \0 character` (UTF-16); reply: LSP LocationLink[]
//                            JSON or null
//   ls_diagnostics()         request: `config \0 path`; reply: LSP Diagnostic[] JSON
//   ls_read_lib()            request: a bundled lib's path, as a definition into it names it; reply: its text, or
//                            empty when it isn't one (so the host can show `lib.dom.d.ts` read-only)
//   ls_output() -> ptr, ls_output_len() -> len    the reply
// `config` is the tsconfig.json the program comes from. A program lives until a file changes; a change to one file
// of it reuses the rest (Program::update_program), and parsed files are cached by content across programs.
// Completions include other modules' exports (auto-imports): the first completion that needs them indexes the
// project and its node_modules (tsrs's auto-import registry); file changes mark what they touch for reindexing, as
// tsrs's project snapshots do.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::fmt::Display;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use rustc_hash::FxHashMap;
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::collections::Set;
use tsrs_core::json::{JsonMap, Value};
use tsrs_core::{P, alloc_str};
use tsrs_core::context::Context;
use tsrs_core::tspath::{Path, to_path};
use tsrs_lsproto as lsproto;
use tsrs_tsoptions::{self as tsoptions, ParseConfigHost, ParsedCommandLine};
use tsrs_vfs::vfstest::{self, MapFS};
use tsrs_vfs::{FS, bundled, vfsmatch};

use tsrs_ls::autoimport::{ProjectID, Registry, RegistryChange, RegistryCloneHost, new_registry};
use tsrs_ls::lsconv::{self, Converters, compute_lsp_line_starts};
use tsrs_ls::lsutil::{UserPreferences, new_default_user_preferences};
use tsrs_ls::sourcemap::ECMALineInfo;
use tsrs_ls::{Host, LanguageService, is_err_needs_auto_imports, new_language_service};
use tsrs_module::ResolutionHost;
use tsrs_module::packagejson::{self, InfoCacheEntry, PackageJson};
use tsrs_projectutil::logging::LogTree;

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

/// The auto-import registry, shared by the State (which replaces it) and the language service (which reads it).
type SharedRegistry = Arc<Mutex<Option<Arc<Registry>>>>;

fn preferences() -> UserPreferences {
    let mut p = new_default_user_preferences();
    p.auto_import_entrypoint_directory_search = tsrs_core::Tristate::True;
    p
}

struct LsHost {
    fs: Arc<dyn FS>,
    converters: Arc<Converters>,
    registry: SharedRegistry,
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
        preferences()
    }
    fn get_ecma_line_info(&self, _: &str) -> Option<Arc<ECMALineInfo>> {
        None
    }
    fn auto_import_registry(&self) -> Option<Arc<Registry>> {
        self.registry.lock().unwrap().clone()
    }
    // Import path completions list the project's directories (what the host pushed in).
    fn read_directory(
        &self,
        current_dir: &str,
        path: &str,
        extensions: &[String],
        excludes: &[String],
        includes: &[String],
        depth: usize,
    ) -> Vec<String> {
        vfsmatch::read_directory(&*self.fs, current_dir, path, extensions, excludes, includes, depth)
    }
    fn get_directories(&self, path: &str) -> Vec<String> {
        self.fs.get_accessible_entries(path).directories
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

/// What the auto-import registry reads while it (re)indexes: the one program, and files from the same file system.
struct CloneHost {
    fs: Arc<dyn FS>,
    host: Arc<CachingHost>,
    project_id: ProjectID,
    program: &'static Program,
}

impl ResolutionHost for CloneHost {
    fn fs(&self) -> &dyn FS {
        &*self.fs
    }
    fn get_current_directory(&self) -> &str {
        "/"
    }
}

impl RegistryCloneHost for CloneHost {
    fn get_default_project(&self, _: &Path) -> (Option<ProjectID>, Option<&'static Program>) {
        (Some(self.project_id.clone()), Some(self.program))
    }
    fn get_program_for_project(&self, id: &ProjectID) -> Option<&'static Program> {
        (*id == self.project_id).then_some(self.program)
    }
    // As tsrs_project's AutoImportRegistryCloneHost does, except that the project's own package.json depends on
    // every package the program loads files from (see `with_program_packages`).
    fn get_package_json(&self, file_name: &str) -> P<InfoCacheEntry> {
        let package_directory = alloc_str(&tsrs_core::tspath::get_directory_path(file_name));
        let text = self.fs.read_file(file_name);
        let text = if file_name.contains("/node_modules/") { text } else { text.map(|t| with_program_packages(&t, self.program)) };
        let Some(text) = text else {
            return P::new(InfoCacheEntry {
                directory_exists: self.fs.directory_exists(package_directory),
                package_directory,
                contents: None,
            });
        };
        let contents = match packagejson::parse(&text) {
            Ok(fields) => PackageJson::new(fields, true),
            Err(_) => PackageJson::new(packagejson::Fields::default(), false),
        };
        P::new(InfoCacheEntry { directory_exists: true, package_directory, contents: Some(P::new(contents)) })
    }
    // The program's own (bound) file when it has one, as tsrs's parse cache would hand out. Anything else is parsed
    // here and kept out of the cache: clone_registry allocates in a scratch region it frees before returning, so a
    // file parsed here mustn't outlive the call.
    fn get_source_file(&self, file_name: &str, path: &Path) -> Option<P<SourceFile>> {
        if let Some(file) = self.program.get_source_file_by_path(path) {
            return Some(file);
        }
        self.host.inner.get_source_file(SourceFileParseOptions {
            file_name: file_name.to_owned(),
            path: path.clone(),
            ..Default::default()
        })
    }
    fn dispose(&self) {}
}

/// `package_json` with every package `program` loads files from added to its `dependencies`. The registry indexes
/// a project's dependencies and the packages its program imports, but not those pulled in by `/// <reference types>`:
/// bun-types, @types/node and undici-types, which declare `bun:*` and `node:*` (`declare module`), come in that way
/// through @types/bun, which is a devDependency (also not indexed) when it's listed at all.
fn with_program_packages(package_json: &str, program: &Program) -> String {
    let Ok(Value::Object(mut root)) = tsrs_core::json::unmarshal(package_json) else { return package_json.to_owned() };
    let mut deps = match root.shift_remove("dependencies") {
        Some(Value::Object(deps)) => deps,
        _ => JsonMap::new(),
    };
    for file in program.get_source_files() {
        let name = file.file_name();
        let Some(at) = name.rfind("/node_modules/") else { continue };
        let rest = &name[at + "/node_modules/".len()..];
        let segments = if rest.starts_with('@') { 2 } else { 1 };
        let package = rest.splitn(segments + 1, '/').take(segments).collect::<Vec<_>>().join("/");
        if !deps.contains_key(&package) {
            deps.insert(package, Value::String("*".into()));
        }
    }
    root.insert("dependencies", Value::Object(deps));
    tsrs_core::json::marshal(&Value::Object(root)).unwrap_or_else(|_| package_json.to_owned())
}

/// File changes since the registry last saw the program, for it to mark what needs reindexing.
#[derive(Default)]
struct RegistryChanges {
    changed: Set<lsproto::DocumentUri>,
    created: Set<lsproto::DocumentUri>,
    deleted: Set<lsproto::DocumentUri>,
    /// The program was built anew (not updated in place): Some(true), as its files may differ.
    rebuilt: Option<bool>,
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
    registry: SharedRegistry,
    registry_changes: RegistryChanges,
    /// Files completions were asked in: the editor's open files, as far as the registry is concerned. Without them
    /// an update drops the buckets it built for them, and the next completion indexes everything again.
    open_files: FxHashMap<Path, String>,
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
        let signature = &mut caps.text_document.signature_help.signature_information;
        signature.documentation_format = vec![lsproto::MarkupKind::MARKDOWN];
        signature.active_parameter_support = true;
        caps.text_document.definition.link_support = true;
        let ctx = lsproto::with_client_capabilities(&Context::background(), Arc::new(caps));
        State {
            mem,
            fs,
            host,
            ctx,
            project: None,
            dirty: Some(Vec::new()),
            registry: SharedRegistry::default(),
            registry_changes: RegistryChanges::default(),
            open_files: FxHashMap::default(),
        }
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
        let old = self.mem.read_file(path);
        if old.as_deref() == Some(text) {
            return;
        }
        let _ = self.mem.write_file(path, text);
        self.changed(path);
        let uri = lsconv::file_name_to_document_uri(path);
        if old.is_some() { self.registry_changes.changed.add(uri) } else { self.registry_changes.created.add(uri) }
    }

    fn remove_file(&mut self, path: &str) {
        if self.mem.remove(path).is_ok() {
            self.dirty = None;
            self.open_files.remove(&to_path(path, "/", true));
            self.registry_changes.deleted.add(lsconv::file_name_to_document_uri(path));
        }
    }

    /// Hands the registry what changed since it last looked, and with `requested` (a file of the program) indexes
    /// what completions in that file can import.
    fn update_registry(&mut self, requested: Option<&str>) {
        let Some(project) = &self.project else { return };
        let mut registry = self.registry.lock().unwrap();
        // Nothing to mark in a registry that doesn't exist yet: the first request indexes from scratch.
        if registry.is_none() && requested.is_none() {
            self.registry_changes = RegistryChanges::default();
            return;
        }
        let changes = std::mem::take(&mut self.registry_changes);
        let id = ProjectID(project.config.clone());
        if let Some(file) = requested {
            self.open_files.insert(to_path(file, "/", true), file.to_owned());
        }
        let mut change = RegistryChange {
            open_files: self.open_files.clone(),
            changed: changes.changed,
            created: changes.created,
            deleted: changes.deleted,
            ..Default::default()
        };
        if let Some(different) = changes.rebuilt {
            change.rebuilt_programs.insert(id.clone(), different);
        }
        if let Some(file) = requested {
            change.requested_file = to_path(file, "/", true);
            change.requested_file_name = file.to_owned();
        }
        let host = CloneHost { fs: Arc::clone(&self.fs), host: Arc::clone(&self.host), project_id: id, program: project.program };
        let old = registry.take().unwrap_or_else(|| {
            new_registry(Arc::new(|f: &str| to_path(f, "/", true)), preferences())
        });
        *registry = Some(old.clone_registry(&self.ctx, &change, &host, LogTree::nil()));
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
            // change touches imports). It expects a file it has; one it doesn't may be about to join it.
            (Some(project), Some([path])) if current && project.program.get_source_file(path).is_some() => {
                let (program, _, reused) = project.program.update_program(
                    &to_path(path, "/", true),
                    Arc::<CachingHost>::clone(&self.host),
                    None,
                    None,
                );
                if !reused {
                    self.registry_changes.rebuilt = Some(true);
                }
                program
            }
            _ => {
                let config_host: &'static ConfigHost = Box::leak(Box::new(ConfigHost { fs: Arc::clone(&self.fs) }));
                let (command_line, _) =
                    tsoptions::get_parsed_command_line_of_config_file(config, None, None, config_host, None);
                self.registry_changes.rebuilt = Some(true);
                new_program(ProgramOptions::new(P::new(command_line?), Arc::<CachingHost>::clone(&self.host)))
            }
        };
        let lines = Arc::clone(&self.fs);
        let converters = lsconv::new_converters(lsproto::PositionEncodingKind::UTF16, move |name| {
            lines.read_file(name).map(|text| compute_lsp_line_starts(&text))
        });
        let host = Arc::new(LsHost { fs: Arc::clone(&self.fs), converters, registry: Arc::clone(&self.registry) });
        let ls = new_language_service(ProjectID(config.to_owned()), program, host, config);
        self.project = Some(Project { config: config.to_owned(), program, ls });
        self.update_registry(None);
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
    let mut result = project.ls.provide_completion(&ctx, &uri, position, Some(&context));
    // The first completion at a name, or the first since a change the registry hasn't indexed: index, then ask again.
    if matches!(&result, Err(e) if is_err_needs_auto_imports(e)) {
        state.update_registry(Some(path));
        let Some(project) = state.project(config) else { return "null".into() };
        result = project.ls.provide_completion(&ctx, &uri, position, Some(&context));
    }
    match result {
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

fn signature_help(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, path, line, character, trigger, retrigger] = f.as_slice() else { return "null".into() };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "null".into() };
    if project.program.get_source_file(path).is_none() {
        return "null".into();
    }
    let uri = lsconv::file_name_to_document_uri(path);
    let position = lsproto::Position { line: line.parse().unwrap_or(0), character: character.parse().unwrap_or(0) };
    // active_signature_help is private: start from the default.
    let mut context = lsproto::SignatureHelpContext::default();
    context.trigger_kind = if trigger.is_empty() {
        lsproto::SignatureHelpTriggerKind::INVOKED
    } else {
        lsproto::SignatureHelpTriggerKind::TRIGGER_CHARACTER
    };
    context.trigger_character = (!trigger.is_empty()).then(|| trigger.clone());
    context.is_retrigger = retrigger == "1";
    match project.ls.provide_signature_help(&ctx, &uri, position, Some(&context)) {
        Ok(lsproto::SignatureHelpOrNull { signature_help: Some(help) }) => json(&help),
        _ => "null".into(),
    }
}

fn definition(state: &mut State, request: &[u8]) -> String {
    let f = fields(request);
    let [config, path, line, character] = f.as_slice() else { return "null".into() };
    let ctx = state.ctx.clone();
    let Some(project) = state.project(config) else { return "null".into() };
    if project.program.get_source_file(path).is_none() {
        return "null".into();
    }
    let uri = lsconv::file_name_to_document_uri(path);
    let position = lsproto::Position { line: line.parse().unwrap_or(0), character: character.parse().unwrap_or(0) };
    project.ls.provide_definition(&ctx, &uri, position).map_or_else(|_| "null".into(), |r| json(&r))
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
    pub extern "C" fn ls_signature_help() {
        with(super::signature_help);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_definition() {
        with(super::definition);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_diagnostics() {
        with(super::diagnostics);
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn ls_read_lib() {
        with(|_, request| {
            let path = std::str::from_utf8(request).unwrap_or("");
            tsrs_vfs::bundled::embedded_file(path).unwrap_or("").to_owned()
        });
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
