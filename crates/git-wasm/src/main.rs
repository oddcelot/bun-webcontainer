// A small `git` on gitoxide for the playground: a WASI command module (`_start`, argv via WASI args). The project root
// is the preopen `/`, which is also the cwd. HTTP goes through the host (http.rs); no threads, no child processes.
mod config;
mod diff;
mod history;
mod http;
mod index;
mod merge;
mod net;
mod push;
mod rebase;
mod refs;
mod rename;
mod stash;
mod status;
mod tag;
mod worktree;

use gix::bstr::{BString, ByteSlice};
use std::io::Write;

/// A failure that ends the command: `code` 128 is `fatal:`, 1 is `error:`.
pub struct Exit {
    pub code: i32,
    pub msg: String,
}

impl<E: std::error::Error> From<E> for Exit {
    fn from(e: E) -> Self {
        // With its causes, as git prints them: the outermost alone rarely says what went wrong.
        let mut msg = format!("fatal: {e:#}");
        let mut cause = e.source();
        while let Some(c) = cause {
            let text = c.to_string();
            if !msg.ends_with(&text) {
                msg.push_str(&format!(": {text}"));
            }
            cause = c.source();
        }
        Exit { code: 128, msg }
    }
}

pub fn fatal<T>(msg: impl std::fmt::Display) -> Result<T, Exit> {
    Err(Exit { code: 128, msg: format!("fatal: {msg}") })
}

pub fn error<T>(msg: impl std::fmt::Display) -> Result<T, Exit> {
    Err(Exit { code: 1, msg: format!("error: {msg}") })
}

pub type Res = Result<i32, Exit>;

pub struct Ctx {
    pub repo: gix::Repository,
    pub color: bool,
}

impl Ctx {
    pub fn paint(&self, code: &str, s: &str) -> String {
        if self.color { format!("\x1b[{code}m{s}\x1b[m") } else { s.to_string() }
    }
}

pub fn out(s: &str) {
    let _ = std::io::stdout().write_all(s.as_bytes());
}

pub fn out_bytes(b: &[u8]) {
    let _ = std::io::stdout().write_all(b);
}

pub fn use_color() -> bool {
    std::env::var("GIT_COLOR").is_ok_and(|v| v == "1")
}

const WORK_DIR: &str = "/";

fn open() -> Result<Ctx, Exit> {
    // The host filesystem has no exec bits: ignore the mode bits (a 100755 entry would read as modified).
    let opts = gix::open::Options::default().config_overrides(["core.fileMode=false"]);
    if !std::path::Path::new("/.git").exists() {
        return fatal("not a git repository (or any of the parent directories): .git");
    }
    Ok(Ctx { repo: gix::open_opts(WORK_DIR, opts)?, color: use_color() })
}

fn init() -> Res {
    if std::path::Path::new("/.git/HEAD").exists() {
        out("Reinitialized existing Git repository in /.git/\n");
        return Ok(0);
    }
    gix::init(WORK_DIR)?;
    let mut cfg = std::fs::OpenOptions::new().append(true).open("/.git/config")?;
    cfg.write_all(b"[core]\n\tfileMode = false\n")?;
    std::fs::create_dir_all("/.git/info")?;
    std::fs::write("/.git/info/exclude", "node_modules/\n")?;
    out("Initialized empty Git repository in /.git/\n");
    Ok(0)
}

const USAGE: &str = "usage: git <command> [<args>]

Supported in the playground:
   init       Create an empty Git repository
   status     Show the working tree status (-s, --porcelain [-z] [-b], -u<mode>)
   add        Add file contents to the index (<pathspec>..., ., -A, -u)
   rm         Remove files from the index and the working tree (--cached)
   restore    Restore files (--staged, --worktree, --source=<rev>, <pathspec>...)
   reset      Move HEAD and reset the index or files (--soft, --mixed, --hard, [<rev>] [--] [<pathspec>...])
   commit     Record changes (-m <msg>, -a, --amend, --no-edit, --allow-empty)
   log        Show commit logs (--oneline, --format=<fmt>, -n <N>, --skip, --all, <rev>, -- <path>)
   diff       Show changes (--cached, --staged)
   show       Show a commit, or a file: <rev>:<path>, :<path>
   branch     List, create, delete (-d, -D), rename (-m) branches, --show-current, --format
   switch     Switch branches (<branch>, -c <new> [<start>], --detach, -f)
   checkout   Switch branches or restore files (<branch>, -b <new>, <rev> -- <path>...)
   rebase     Replay the branch's commits onto another ([--onto <newbase>] [<upstream> [<branch>]], --[no-]fork-point, -X <opt>, -q, --continue, --skip, --abort, --quit)
   merge      Join a branch into the current one (<rev>..., --no-ff, --ff-only, --squash, --no-commit, -m <msg>, -s ours, -X ours|theirs, --abort, --continue)
   tag        List, create or delete tags (-l [<pattern>...], -n<num>, --sort=<key>, --contains, --merged, --points-at, --format, -i, -a, -m <msg>, -F <file>, -f, -d)
   stash      Set changes aside (push [-m <msg>] [-u|-a] [-k] [-S] [-- <path>...], save, list, show [-p], apply [--index], pop, drop, clear, branch, create, store)
   clean      Remove untracked files (-n, -f, -d)
   config     Get and set options in the repository config (--get, --unset, --list)
   rev-parse  Print the object id of a revision (--verify, --abbrev-ref)
   clone      Clone a repository into the (empty) project (<url> [.], --depth <n>, -b <branch>)
   fetch      Download objects and refs from a remote ([<remote>], --depth <n>)
   pull       Fetch, then merge into the current branch ([<remote> [<branch>]], --ff-only, --no-ff)
   push       Update a remote branch ([<remote> [[+]<src>[:<dst>]...]], -f, -u, -d, -n)
   remote     Manage remotes (-v, add <name> <url>, remove, get-url, set-url)
";

fn run(args: &[String]) -> Res {
    let Some(cmd) = args.first() else {
        out(USAGE);
        return Ok(1);
    };
    let rest = &args[1..];
    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            out(USAGE);
            Ok(0)
        }
        "init" => init(),
        "status" => status::status(&open()?, rest),
        "add" => index::add(&open()?, rest),
        "rm" => index::rm(&open()?, rest),
        "reset" => worktree::reset(&open()?, rest),
        "restore" => worktree::restore(&open()?, rest),
        "switch" => worktree::switch(&open()?, rest),
        "checkout" => worktree::checkout(&open()?, rest),
        "clean" => worktree::clean(&open()?, rest),
        "config" => config::config(rest),
        "commit" => history::commit(&open()?, rest),
        "log" => history::log(&open()?, rest),
        "diff" => diff::diff(&open()?, rest),
        "show" => refs::show(&open()?, rest),
        "branch" => refs::branch(&open()?, rest),
        "rev-parse" => refs::rev_parse(&open()?, rest),
        "clone" => net::clone(rest),
        "fetch" => net::fetch(&open()?, rest),
        "pull" => net::pull(&open()?, rest),
        "remote" => net::remote(&open()?, rest),
        "push" => push::push(&open()?, rest),
        "merge" => merge::merge(&open()?, rest),
        "tag" => tag::tag(&open()?, rest),
        "stash" => stash::stash(&open()?, rest),
        "rebase" => rebase::rebase(&open()?, rest),
        _ => {
            eprintln!("git: '{cmd}' is not a git command or not supported in the playground");
            Ok(1)
        }
    }
}

fn main() {
    http::install();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{}", e.msg);
            e.code
        }
    };
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}

/// Pathspecs relative to the root `/`: `.` and no spec match everything, otherwise a path or directory prefix.
pub struct Specs {
    specs: Vec<String>,
    hit: std::cell::RefCell<Vec<bool>>,
}

impl Specs {
    pub fn new(args: &[String]) -> Self {
        let specs: Vec<String> = args
            .iter()
            .map(|a| {
                let a = a.trim_start_matches("./").trim_start_matches('/').trim_end_matches('/');
                if a == "." { String::new() } else { a.to_string() }
            })
            .collect();
        let n = specs.len();
        Specs { specs, hit: std::cell::RefCell::new(vec![false; n]) }
    }

    pub fn is_all(&self) -> bool {
        self.specs.is_empty() || self.specs.iter().any(|s| s.is_empty())
    }

    pub fn matches(&self, path: &str) -> bool {
        if self.specs.is_empty() {
            return true;
        }
        let path = path.trim_end_matches('/');
        let mut any = false;
        for (i, s) in self.specs.iter().enumerate() {
            let m = s.is_empty() || path == s || path.strip_prefix(s.as_str()).is_some_and(|r| r.starts_with('/'))
                // an untracked directory entry `dir/` that contains the spec
                || s.strip_prefix(path).is_some_and(|r| r.starts_with('/'));
            if m {
                self.hit.borrow_mut()[i] = true;
                any = true;
            }
        }
        any
    }

    /// The first spec nothing matched.
    pub fn unmatched(&self) -> Option<&str> {
        self.hit.borrow().iter().position(|h| !h).map(|i| self.specs[i].as_str()).filter(|s| !s.is_empty())
    }

    /// `fatal: pathspec 'x' did not match any files` for the first spec nothing matched.
    pub fn check_all_matched(&self) -> Result<(), Exit> {
        for (i, h) in self.hit.borrow().iter().enumerate() {
            if !h && !self.specs[i].is_empty() {
                return fatal(format!("pathspec '{}' did not match any files", self.specs[i]));
            }
        }
        Ok(())
    }
}

pub fn path_str(p: &BString) -> String {
    p.to_str_lossy().into_owned()
}

/// Non-flag arguments (after an optional `--`).
pub fn positional(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut only = false;
    for a in args {
        if !only && a == "--" {
            only = true;
        } else if only || !a.starts_with('-') {
            out.push(a.clone());
        }
    }
    out
}
