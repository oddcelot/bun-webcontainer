//! `bun check` (Bun's TypeScript 7 type checker, `bun_sema_driver`) behind a pointer+length C ABI, over the host's file
//! system: the `bun_sys.*` imports, which the playground serves from its VFS. What bun/src/cli/check_command.rs does,
//! without the parts that need the rest of Bun: one thread, no progress line, and the working directory is the root.

mod libs;

use bun_sema_driver::format::{self, Layout, Style};
use bun_sema_driver::host::Provided;
use bun_sema_driver::{CommandLine, FlagError, PlanOptions, Report, Request};

// The C/C++ symbols the checker links against.
use bun_wasm_stubs as _;
// The bun_sys_host_* symbols bun_sys declares, as `bun_sys.*` wasm imports served by the VFS.
use bun_sys_host as _;

const CWD: &[u8] = b"/";

#[derive(Default)]
pub struct Options {
    pub command_line: CommandLine,
    /// `--pretty`, `--no-pretty`; else colors decide, as a terminal would.
    pub pretty: Option<bool>,
    pub all: bool,
    pub timing: bool,
}

pub struct Outcome {
    pub exit_code: u8,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn usage(message: &[u8]) -> Outcome {
    Outcome { exit_code: 1, stdout: Vec::new(), stderr: [b"error: ", message, b"\nnote: run 'bun check --help' for more information\n"].concat() }
}

/// `bun check`'s arguments (everything after `check`).
pub fn parse(args: &[&[u8]]) -> Result<Options, Vec<u8>> {
    let mut options = Options::default();
    let (mut flags, mut paths, mut project) = (Vec::new(), Vec::new(), None);
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        match arg {
            b"--" => paths.extend(args.by_ref().map(<[u8]>::to_vec)),
            b"-p" | b"--project" | b"--tsconfig-override" => match args.next() {
                Some(path) => project = Some(path.to_vec()),
                None => return Err([arg, b" needs a value"].concat()),
            },
            b"--no-pretty" => options.pretty = Some(false),
            b"--all" => options.all = true,
            b"--timing" => options.timing = true,
            b"--no-emit" | b"--no-script" => {}
            b"--watch" | b"-w" => return Err(b"--watch is not supported here".to_vec()),
            _ if arg.starts_with(b"--threads") || arg.starts_with(b"--cwd") => {
                return Err([&b"bun check "[..], arg, b" is not supported here"].concat());
            }
            _ => flags.push(arg),
        }
    }
    let mut command_line = bun_sema_driver::parse_command_line(&flags, CWD);
    if let Some(rejected) = command_line.rejected.first() {
        let flag = &rejected.flag;
        return Err(match &rejected.error {
            FlagError::Unknown => [&b"Unknown flag \""[..], flag, b"\""].concat(),
            FlagError::NeedsValue => [&flag[..], b" needs a value"].concat(),
            FlagError::BadValue(allowed) if allowed.is_empty() => {
                [&flag[..], b" does not take \"", rejected.value.as_deref().unwrap_or_default(), b"\""].concat()
            }
            FlagError::BadValue(allowed) => [&flag[..], b" must be one of: ", &allowed.join(&b", "[..])].concat(),
        });
    }
    command_line.paths.extend(paths);
    if project.is_some() {
        command_line.project = project;
    }
    if command_line.build && usize::from(command_line.project.is_some()) + command_line.paths.len() > 1 {
        return Err(b"--build takes one project".to_vec());
    }
    if options.pretty.is_none() {
        options.pretty = bun_sema_driver::tristate(&command_line.compiler_options, b"pretty");
    }
    options.command_line = command_line;
    Ok(options)
}

fn style<'a>(options: &Options, colors: bool, cwd: &'a [u8], report: &Report) -> Style<'a> {
    let layout = if options.pretty.unwrap_or(colors) { Layout::Pretty } else { Layout::Plain };
    Style {
        layout,
        color: layout == Layout::Pretty && colors,
        cwd,
        is_case_sensitive: report.is_case_sensitive,
        github_annotations: false,
        width: 0,
        show_all: options.all,
    }
}

/// Checks the project as `bun check` with `options` does. Errors go to stdout, the summary to stderr, like Bun's.
pub fn check(options: &Options, colors: bool) -> Outcome {
    bun_sema_driver::run_regions_inline_on_this_thread();
    let command_line = &options.command_line;
    let request = Request {
        cwd: CWD,
        project: command_line.project.as_deref(),
        listed_projects: None,
        build: command_line.build,
        errors: &command_line.errors,
        paths: &command_line.paths,
        are_entry_points: false,
        script_kinds: &[],
        script_kinds_by_extension: &[],
        conditions: &[],
        compiler_options: &command_line.compiler_options,
        threads: 1,
        libs: bun_sema_driver::Libs::Bundled(libs::BUNDLED),
        progress: None,
        order: 1,
        plan_options: PlanOptions::default(),
        stops_like_tsc: true,
        uses_typescript_wording: false,
        after_file: None,
    };
    bun_sema_driver::check_provided_then(&request, Provided::default(), |report| {
        let cwd = bun_sema_driver::host::from_native(CWD);
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        format::write_diagnostics(&mut stdout, &report, &style(options, colors, &cwd, &report));
        format::write_summary(&mut stderr, &report, &style(options, colors, &cwd, &report));
        if options.timing {
            use std::io::Write;
            let _ = writeln!(
                stderr,
                "  {} files loaded in {:.1}ms, {} checked in {:.1}ms",
                report.files_loaded,
                report.load_time.as_secs_f64() * 1000.0,
                report.files_checked,
                report.check_time.as_secs_f64() * 1000.0,
            );
        }
        Outcome { exit_code: u8::from(!report.is_ok()), stdout, stderr }
    })
}

/// The extensions Bun type-checks before running a file (check_command.rs `has_types`: JavaScript-like loaders).
fn has_types(path: &[u8]) -> bool {
    let extension = path.rsplit(|&b| b == b'.').next().unwrap_or_default();
    path.contains(&b'.') && matches!(extension, b"js" | b"jsx" | b"mjs" | b"cjs" | b"ts" | b"tsx" | b"mts" | b"cts")
}

/// `bun --check <file>`: type-checks the entry point and what it imports, as check_command.rs `check_before` does,
/// before the program runs. Nothing is printed when there are no diagnostics; otherwise the errors and, if any is an
/// error, the summary, all on stderr (stdout stays the program's). `path` is relative to the root.
pub fn check_entry(path: &[u8], colors: bool) -> Outcome {
    if !has_types(path) {
        return Outcome { exit_code: 0, stdout: Vec::new(), stderr: Vec::new() };
    }
    bun_sema_driver::run_regions_inline_on_this_thread();
    let paths = [path.to_vec()];
    let request = Request {
        cwd: CWD,
        project: None,
        listed_projects: None,
        build: false,
        errors: &[],
        paths: &paths,
        are_entry_points: true,
        script_kinds: &[],
        script_kinds_by_extension: &[],
        conditions: &[],
        compiler_options: &[],
        threads: 1,
        libs: bun_sema_driver::Libs::Bundled(libs::BUNDLED),
        progress: None,
        order: 1,
        plan_options: PlanOptions::default(),
        stops_like_tsc: true,
        uses_typescript_wording: false,
        after_file: None,
    };
    bun_sema_driver::check_provided_then(&request, Provided::default(), |report| {
        let mut stderr = Vec::new();
        if !(report.diagnostics.is_empty() && report.incomplete.is_empty()) {
            let cwd = bun_sema_driver::host::from_native(CWD);
            let style = style(&Options::default(), colors, &cwd, &report);
            format::write_diagnostics(&mut stderr, &report, &style);
            if !report.is_ok() {
                format::write_summary(&mut stderr, &report, &style);
            }
        }
        Outcome { exit_code: u8::from(!report.is_ok()), stdout: Vec::new(), stderr }
    })
}

/// `bun check <args>`.
pub fn run(args: &[&[u8]], colors: bool) -> Outcome {
    match parse(args) {
        Ok(options) => check(&options, colors),
        Err(message) => usage(&message),
    }
}

/// The version of TypeScript the checker is a port of.
pub fn typescript_version() -> &'static [u8] {
    let version = bun_sema_driver::TYPESCRIPT_VERSION;
    version.to_bytes()
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[repr(C)]
pub struct RunOutput {
    pub exit_code: u64,
    pub stdout: *mut u8,
    pub stdout_len: usize,
    pub stderr: *mut u8,
    pub stderr_len: usize,
}

/// `bun check <args>`; `args` are NUL-separated. `colors`: 1 for ANSI colors (and source excerpts, as in a terminal).
/// Free the result with `run_output_free`.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_c(args: *const u8, args_len: usize, colors: u32) -> *mut RunOutput {
    let args = unsafe { core::slice::from_raw_parts(args, args_len) };
    let args: Vec<&[u8]> = if args.is_empty() { Vec::new() } else { args.split(|&b| b == 0).collect() };
    output(run(&args, colors != 0))
}

/// `bun --check <path>` (see `check_entry`). Free the result with `run_output_free`.
///
/// # Safety
/// The input range must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn check_entry_c(path: *const u8, path_len: usize, colors: u32) -> *mut RunOutput {
    let path = unsafe { core::slice::from_raw_parts(path, path_len) };
    output(check_entry(path, colors != 0))
}

fn output(outcome: Outcome) -> *mut RunOutput {
    let leak = |v: Vec<u8>| {
        let b = Box::into_raw(v.into_boxed_slice());
        (b.cast::<u8>(), b.len())
    };
    let (stdout, stdout_len) = leak(outcome.stdout);
    let (stderr, stderr_len) = leak(outcome.stderr);
    Box::into_raw(Box::new(RunOutput { exit_code: u64::from(outcome.exit_code), stdout, stdout_len, stderr, stderr_len }))
}

/// # Safety
/// `out` must come from `run_c`, once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_output_free(out: *mut RunOutput) {
    let out = unsafe { Box::from_raw(out) };
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.stdout, out.stdout_len)) });
    drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(out.stderr, out.stderr_len)) });
}
