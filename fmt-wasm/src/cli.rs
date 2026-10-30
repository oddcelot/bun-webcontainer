//! `bun fmt <args>` itself (`bun_lint_driver::fmt::run`) over the host's file system: the `bun_sys.*` imports, which the
//! playground serves from its VFS. Meant for `--stdin-filepath <path>`, which is what `bun fmt` does for one file:
//! configs for that path (`.prettierrc*`, `package.json`'s `prettier`, `.editorconfig`), `.prettierignore`, and errors
//! with a code frame. The host serves the text as fd 0. `bunfig.toml`'s `[fmt]` is read here, as `bun fmt`'s command
//! line does (`format_command.rs`): the working directory's file only, the root of the VFS.
//!
//! Paths of files go to the host, so this doesn't format a whole directory: that takes `bun fmt`'s thread pool.

use bun_lint_driver::fmt::cli::{Options, UsageError};
use bun_lint_driver::git;
use bun_lint_driver::js_plugin::{Engine, Vm, Work};
use bun_lint_driver::{Environment, Outcome, Script, Stream};

/// No JavaScript here: a config written in JavaScript (`prettier.config.js`) or a Prettier plugin fails to load.
struct NoEngine;

const NO_JAVASCRIPT: &[u8] = b"JavaScript configs and plugins can't run here";

impl Engine for NoEngine {
    fn thread_has_realm(&self) -> bool {
        false
    }
    fn with_vm_here(&self, _size: usize, _then: &mut dyn FnMut(&mut dyn Vm)) -> Result<(), Vec<u8>> {
        Err(NO_JAVASCRIPT.to_vec())
    }
    fn with_vm(&self, _size: usize, _then: &mut (dyn FnMut(&mut dyn Vm) + Send)) -> Result<(), Vec<u8>> {
        Err(NO_JAVASCRIPT.to_vec())
    }
    fn work_off(&self, _work: &dyn Work, _meanwhile: &mut dyn FnMut()) -> Result<(), Vec<u8>> {
        Err(NO_JAVASCRIPT.to_vec())
    }
    fn busy(&self) -> usize {
        0
    }
}

/// `bunfig.toml`'s `[fmt]` as defaults for the command line, if the file has one.
fn bunfig_defaults() -> Result<Option<Options>, Vec<u8>> {
    use bun_sys::{Fd, File, O};
    let Ok(text) = File::openat(Fd::cwd(), b"bunfig.toml", O::RDONLY, 0).and_then(|file| file.read_to_end()) else {
        return Ok(None);
    };
    bun_ast::initialize_store();
    let bump = bun_alloc::Arena::borrowing_default();
    let source = bun_ast::Source::init_path_string("bunfig.toml", &text);
    let mut log = bun_ast::Log::init();
    let Ok(file) = bun_parsers::toml::TOML::parse(&source, &mut log, &bump, true) else {
        return Err(b"bunfig.toml: invalid TOML".to_vec());
    };
    match bun_lint_driver::bunfig::format(&file) {
        Ok(section) => Ok(section.map(|it| it.from_bunfig_at(b"bunfig.toml", false))),
        Err(error) => Err([&b"bunfig.toml: "[..], &error.message].concat()),
    }
}

fn failed(message: &[u8]) -> Outcome {
    Outcome {
        stderr: [b"error: ", message, b"\n"].concat(),
        exit_code: 2,
        ..Outcome::default()
    }
}

/// Runs `bun fmt` with `args` (everything after `fmt`). `colors`: ANSI colors in what it prints.
pub fn run(args: &[&[u8]], colors: bool) -> Outcome {
    let options = match bunfig_defaults() {
        Err(message) => return failed(&message),
        Ok(Some(defaults)) => Options::parse_with_defaults(defaults, args),
        Ok(None) => Options::parse(args),
    };
    let mut options = match options {
        Ok(options) => options,
        Err(UsageError(message)) => return failed(&message),
    };
    options.threads = 1;
    let run_script = |_: &Script| -> Result<Vec<u8>, Vec<u8>> { Err(NO_JAVASCRIPT.to_vec()) };
    let run_git = |_: &git::Command| -> Result<git::Finished, git::NotRun> { Err(git::NotRun::NotFound) };
    let stream = Stream { is_tty: false, colors };
    let environment = Environment {
        cwd: b"/".to_vec(),
        stdout: stream,
        stderr: stream,
        columns: || 80,
        is_ai_agent: false,
        is_github_action: false,
        libs: bun_sema_driver::Libs::Directory(b"/"),
        run_script: &run_script,
        run_git: &run_git,
        command_line: &[],
        js_engine: &NoEngine,
        version: bun_core::Global::package_json_version.as_bytes(),
        memory: 0,
    };
    bun_lint_driver::fmt::run(&options, &environment)
}
