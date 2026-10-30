// Probe ABI: ls_input(len) -> ptr, ls_hover() -> status, ls_output() -> ptr, ls_output_len() -> len.
// Request: NUL-separated UTF-8, `path \0 line \0 character` then `\0 file \0 contents` per file (absolute paths,
// a /tsconfig.json among them). Reply: the LSP HoverResponse as JSON. A fresh Program per call.

use std::sync::Arc;

use tsrs_compiler::{CompilerHost, Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::P;
use tsrs_core::context::Context;
use tsrs_lsproto as lsproto;
use tsrs_tsoptions::{self as tsoptions, ParseConfigHost};
use tsrs_vfs::{FS, bundled, vfstest};

use tsrs_ls::autoimport::{ProjectID, Registry};
use tsrs_ls::lsconv::{self, Converters, compute_lsp_line_starts};
use tsrs_ls::lsutil::{UserPreferences, new_default_user_preferences};
use tsrs_ls::sourcemap::ECMALineInfo;
use tsrs_ls::{Host, new_language_service};

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
        new_default_user_preferences()
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

pub fn hover(request: &[u8]) -> String {
    tsrs_compiler::worker_pool();
    let mut fields = request.split(|&b| b == 0).map(|f| String::from_utf8_lossy(f).into_owned());
    let path = fields.next().unwrap_or_default();
    let line: u32 = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
    let character: u32 = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
    let mut files = Vec::new();
    while let (Some(name), Some(text)) = (fields.next(), fields.next()) {
        files.push((name, text));
    }
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(vfstest::from_map(files.into_iter(), true)));
    let config_host: &'static ConfigHost = Box::leak(Box::new(ConfigHost { fs: Arc::clone(&fs) }));
    let (config, _diagnostics) =
        tsoptions::get_parsed_command_line_of_config_file("/tsconfig.json", None, None, config_host, None);
    let Some(config) = config else { return "null".into() };
    let host: Arc<dyn CompilerHost> = new_compiler_host("/", Arc::clone(&fs), &bundled::lib_path(), None, None, None);
    let program: &'static Program = new_program(ProgramOptions::new(P::new(config), host));
    let lines_fs = Arc::clone(&fs);
    let converters = lsconv::new_converters(lsproto::PositionEncodingKind::UTF16, move |name| {
        lines_fs.read_file(name).map(|text| compute_lsp_line_starts(&text))
    });
    let ls = new_language_service(ProjectID("/tsconfig.json".into()), program, Arc::new(LsHost { fs, converters }), &path);
    let mut caps = lsproto::ResolvedClientCapabilities::default();
    caps.text_document.hover.content_format = vec![lsproto::MarkupKind::MARKDOWN];
    let ctx = lsproto::with_client_capabilities(&Context::background(), Arc::new(caps));
    let params = lsproto::HoverParams {
        text_document: lsproto::TextDocumentIdentifier { uri: lsconv::file_name_to_document_uri(&path) },
        position: lsproto::Position { line, character },
        ..Default::default()
    };
    match ls.provide_hover(&ctx, &params) {
        Ok(r) => tsrs_core::json::marshal(&lsproto::Json::to_json(&r)).unwrap_or_default(),
        Err(_) => "null".into(),
    }
}

#[cfg(target_family = "wasm")]
mod abi {
    use std::cell::RefCell;

    thread_local! {
        static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
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
    pub extern "C" fn ls_hover() -> i32 {
        let request = INPUT.with_borrow_mut(std::mem::take);
        let reply = super::hover(&request);
        OUTPUT.with_borrow_mut(|output| *output = reply.into_bytes());
        0
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
