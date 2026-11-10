// The network commands: clone, fetch, pull (fast-forward only), remote. gix's clone and fetch over the host's HTTP
// (http.rs); checkout writes the files from blobs as switch does (worktree.rs).
use crate::worktree::{commit_flat, hard_reset, move_head, move_to};
use crate::{Ctx, Exit, Res, error, fatal, out, positional, use_color};
use gix::bstr::{BStr, ByteSlice};
use gix::refs::transaction::{Change, PreviousValue};
use gix::remote::fetch::Shallow;
use std::num::NonZeroU32;
use std::sync::atomic::AtomicBool;

const STOP: AtomicBool = AtomicBool::new(false);

/// A gix error with every cause (a failed request is several levels down), as one `fatal:` line.
fn failed(e: gix_error::Error) -> Exit {
    let mut parts: Vec<String> = Vec::new();
    for c in e.iter_errors() {
        let t = c.to_string();
        if !parts.iter().any(|p| p.contains(&t)) {
            parts.push(t);
        }
    }
    Exit { code: 128, msg: format!("fatal: {}", parts.join(": ")) }
}

fn depth(args: &[String]) -> Result<Option<NonZeroU32>, Exit> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let v = if a == "--depth" { it.next().cloned() } else { a.strip_prefix("--depth=").map(str::to_string) };
        if let Some(v) = v {
            return match v.parse::<u32>().ok().and_then(NonZeroU32::new) {
                Some(n) => Ok(Some(n)),
                None => fatal(format!("depth {v} is not a positive number")),
            };
        }
    }
    Ok(None)
}

fn value_of(args: &[String], short: &str, long: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == short || a == long {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(&format!("{long}=")) {
            return Some(v.to_string());
        }
    }
    None
}

/// Positional arguments, without the values of the options that take one.
fn operands(args: &[String], with_value: &[&str]) -> Vec<String> {
    let mut rest = Vec::new();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
        } else if with_value.contains(&a.as_str()) {
            skip = true;
        } else {
            rest.push(a.clone());
        }
    }
    positional(&rest)
}

/// What changed on our side, as git prints it after `From <url>`.
fn report(url: &BStr, outcome: &gix::remote::fetch::Outcome) {
    use gix::remote::fetch::Status;
    let update_refs = match &outcome.status {
        Status::NoPackReceived { update_refs, .. } | Status::Change { update_refs, .. } => update_refs,
    };
    let mut lines = Vec::new();
    for u in &update_refs.updates {
        let Some(edit) = u.edit_index.map(|i| &update_refs.edits[i]) else { continue };
        let local = edit.name.shorten().to_str_lossy().into_owned();
        let remote = local.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| local.clone());
        use gix::remote::fetch::refs::update::Mode;
        let (old, new) = match &edit.change {
            Change::Update { expected: PreviousValue::MustExistAndMatch(o) | PreviousValue::ExistingMustMatch(o), new, .. } => {
                (o.try_id().map(|i| i.to_hex_with_len(7).to_string()), new.try_id().map(|i| i.to_hex_with_len(7).to_string()))
            }
            Change::Update { new, .. } => (None, new.try_id().map(|i| i.to_hex_with_len(7).to_string())),
            Change::Delete { .. } => (None, None),
        };
        let what = match u.mode {
            Mode::New if edit.name.as_bstr().starts_with(b"refs/tags/") => " * [new tag]        ".to_string(),
            Mode::New => " * [new branch]     ".to_string(),
            Mode::FastForward => format!("   {}..{}  ", old.unwrap_or_default(), new.unwrap_or_default()),
            Mode::Forced => format!(" + {}...{} ", old.unwrap_or_default(), new.unwrap_or_default()),
            _ => continue,
        };
        lines.push(format!("{what}{remote:<10} -> {local}\n"));
    }
    if !lines.is_empty() {
        eprintln!("From {url}");
        for l in lines {
            eprint!("{l}");
        }
    }
}

/// `github.com` of `https://github.com/a/b`.
pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    rest.split(['/', ':']).next().unwrap_or(rest)
}

/// The project's files but node_modules (which git never sees here): what `clone` must find empty.
fn worktree_empty() -> bool {
    std::fs::read_dir("/").map(|d| d.flatten().all(|e| e.file_name() == "node_modules")).unwrap_or(true)
}

pub fn clone(args: &[String]) -> Res {
    let ops = operands(args, &["--depth", "-b", "--branch", "-o", "--origin"]);
    let Some(url) = ops.first() else {
        return fatal("You must specify a repository to clone.");
    };
    if let Some(dir) = ops.get(1).filter(|d| !matches!(d.as_str(), "." | "./" | "/")) {
        return fatal(format!("the playground clones into the project itself ('.'), not into '{dir}'"));
    }
    if std::path::Path::new("/.git").exists() || !worktree_empty() {
        return fatal("destination path '.' already exists and is not an empty directory.");
    }
    eprintln!("Cloning into '.'...");
    crate::http::report(&format!("Connecting to {}", host_of(url)));
    let mut prepare = gix::clone::PrepareFetch::new(
        url.as_str(),
        "/",
        gix::create::Kind::WithWorktree,
        gix::create::Options { destination_must_be_empty: Some(false), ..Default::default() },
        gix::open::Options::default().config_overrides(["core.fileMode=false"]),
    )?;
    if let Some(n) = depth(args)? {
        prepare = prepare.with_shallow(Shallow::DepthAtRemote(n));
    }
    if let Some(b) = value_of(args, "-b", "--branch") {
        prepare = prepare.with_ref_name(Some(b.as_str()))?;
    }
    if let Some(name) = value_of(args, "-o", "--origin") {
        prepare = prepare.with_remote_name(name)?;
    }
    let (_repo, _outcome) = match prepare.fetch_only(gix::progress::Discard, &STOP) {
        Ok(r) => r,
        Err(e) => {
            // gix leaves the .git it made when the destination wasn't empty (node_modules): clone leaves nothing.
            let _ = std::fs::remove_dir_all("/.git");
            return Err(failed(e));
        }
    };
    // As `init` does: no exec bits on the host, node_modules stays out.
    let mut cfg = crate::config::load()?;
    cfg.set_raw_value_by("core", None, "fileMode", "false".as_bytes().as_bstr())?;
    crate::config::save(&cfg)?;
    std::fs::create_dir_all("/.git/info")?;
    std::fs::write("/.git/info/exclude", "node_modules/\n")?;
    let ctx = Ctx { repo: gix::open_opts("/", gix::open::Options::default().config_overrides(["core.fileMode=false"]))?, color: use_color() };
    match ctx.repo.head_commit() {
        Ok(c) => {
            let files = commit_flat(&ctx, &c)?;
            crate::http::report(&format!("Checking out {} files", files.len()));
            hard_reset(&ctx, &files, true)?
        }
        Err(_) => eprintln!("warning: You appear to have cloned an empty repository."),
    }
    Ok(0)
}

/// The remote a command names, or the current branch's, or `origin`.
pub fn remote_name(ctx: &Ctx, named: Option<&String>) -> String {
    if let Some(n) = named {
        return n.clone();
    }
    let branch = ctx.repo.head_name().ok().flatten().map(|n| n.shorten().to_string());
    branch
        .and_then(|b| ctx.repo.config_snapshot().string(format!("branch.{b}.remote").as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "origin".into())
}

fn fetch_from(ctx: &Ctx, name: &str, args: &[String]) -> Result<gix::remote::fetch::Outcome, Exit> {
    // Updating the tracking refs writes reflogs, which need a committer.
    let repo = crate::history::with_committer(ctx)?;
    let remote = match repo.find_remote(name) {
        Ok(r) => r,
        Err(_) => return fatal(format!("'{name}' does not appear to be a git repository")),
    };
    let url = remote.url(gix::remote::Direction::Fetch).map(|u| u.to_bstring()).unwrap_or_default();
    crate::http::report(&format!("Connecting to {}", host_of(&url.to_str_lossy())));
    let mut prepare = remote
        .connect(gix::remote::Direction::Fetch)
        .and_then(|c| c.prepare_fetch(gix::progress::Discard, Default::default()))
        .map_err(failed)?;
    if let Some(n) = depth(args)? {
        prepare = prepare.with_shallow(Shallow::DepthAtRemote(n));
    }
    let outcome = prepare.receive(gix::progress::Discard, &STOP).map_err(failed)?;
    report(url.as_ref(), &outcome);
    Ok(outcome)
}

pub fn fetch(ctx: &Ctx, args: &[String]) -> Res {
    let ops = operands(args, &["--depth"]);
    let name = remote_name(ctx, ops.first());
    fetch_from(ctx, &name, args)?;
    Ok(0)
}

/// `pull`: fetch, then fast-forward the current branch to its upstream (no merge or rebase yet).
pub fn pull(ctx: &Ctx, args: &[String]) -> Res {
    let ops = operands(args, &["--depth"]);
    let Some(branch) = ctx.repo.head_name().ok().flatten().map(|n| n.shorten().to_string()) else {
        return fatal("You are not currently on a branch.");
    };
    let name = remote_name(ctx, ops.first());
    fetch_from(ctx, &name, args)?;
    let snapshot = ctx.repo.config_snapshot();
    let merge = ops
        .get(1)
        .cloned()
        .or_else(|| snapshot.string(format!("branch.{branch}.merge").as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| format!("refs/heads/{branch}"));
    let tracking = format!("refs/remotes/{name}/{}", merge.trim_start_matches("refs/heads/"));
    let Ok(target) = ctx.repo.rev_parse_single(tracking.as_str()).and_then(|id| Ok(id.object()?.peel_to_commit()?)).map_err(|_| ())
    else {
        return fatal(format!("couldn't find remote ref {merge}"));
    };
    let head = ctx.repo.head_id().ok().map(|i| i.detach());
    if head == Some(target.id) {
        out("Already up to date.\n");
        return Ok(0);
    }
    if let Some(head) = head {
        // The upstream is already in our history (we're only ahead): nothing to bring in.
        if ctx.repo.rev_walk([head]).all()?.filter_map(Result::ok).any(|i| i.id == target.id) {
            out("Already up to date.\n");
            return Ok(0);
        }
        // Fast-forward only: our commit must be in the upstream's history.
        let ancestor = ctx.repo.rev_walk([target.id]).all()?.filter_map(Result::ok).any(|i| i.id == head);
        if !ancestor {
            return error("Not possible to fast-forward, aborting. (merge and rebase aren't supported in the playground yet)");
        }
    }
    crate::http::report("Updating files");
    move_to(ctx, &target, false)?;
    move_head(ctx, target.id, &format!("pull: Fast-forward"))?;
    out(&format!("Updating {}..{}\nFast-forward\n", head.map(|h| h.to_hex_with_len(7).to_string()).unwrap_or_default(), target.id.to_hex_with_len(7)));
    Ok(0)
}

pub fn remote(ctx: &Ctx, args: &[String]) -> Res {
    let verbose = args.iter().any(|a| a == "-v" || a == "--verbose");
    let pos = positional(args);
    let names = || -> Vec<String> { ctx.repo.remote_names().into_iter().map(|n| n.to_string()).collect() };
    let url_of = |name: &str| ctx.repo.config_snapshot().string(format!("remote.{name}.url").as_str()).map(|s| s.to_string());
    match pos.first().map(String::as_str) {
        None => {
            for n in names() {
                match (verbose, url_of(&n)) {
                    (true, Some(u)) => out(&format!("{n}\t{u} (fetch)\n{n}\t{u} (push)\n")),
                    _ => out(&format!("{n}\n")),
                }
            }
            Ok(0)
        }
        Some("add") => {
            let (Some(name), Some(url)) = (pos.get(1), pos.get(2)) else {
                return error("usage: git remote add <name> <url>");
            };
            if names().contains(name) {
                return error(format!("remote {name} already exists."));
            }
            let mut cfg = crate::config::load()?;
            let sub = Some(name.as_bytes().as_bstr());
            cfg.set_raw_value_by("remote", sub, "url", url.as_bytes().as_bstr())?;
            cfg.set_raw_value_by("remote", sub, "fetch", format!("+refs/heads/*:refs/remotes/{name}/*").as_bytes().as_bstr())?;
            crate::config::save(&cfg)?;
            Ok(0)
        }
        Some("remove" | "rm") => {
            let Some(name) = pos.get(1) else {
                return error("usage: git remote remove <name>");
            };
            if !names().contains(name) {
                return error(format!("No such remote: '{name}'"));
            }
            let mut cfg = crate::config::load()?;
            while cfg.remove_section("remote", Some(name.as_bytes().as_bstr())).is_some() {}
            crate::config::save(&cfg)?;
            // Its tracking branches go with it.
            let prefix = format!("refs/remotes/{name}/");
            let refs: Vec<_> = ctx.repo.references()?.prefixed(prefix.as_str())?.filter_map(Result::ok).map(|r| r.name().to_owned()).collect();
            for r in refs {
                if let Ok(r) = ctx.repo.find_reference(&r) {
                    let _ = r.delete();
                }
            }
            Ok(0)
        }
        Some("get-url") => match pos.get(1).and_then(|n| url_of(n)) {
            Some(u) => {
                out(&format!("{u}\n"));
                Ok(0)
            }
            None => error(format!("No such remote '{}'", pos.get(1).cloned().unwrap_or_default())),
        },
        Some("set-url") => {
            let (Some(name), Some(url)) = (pos.get(1), pos.get(2)) else {
                return error("usage: git remote set-url <name> <newurl>");
            };
            if !names().contains(name) {
                return error(format!("No such remote '{name}'"));
            }
            let mut cfg = crate::config::load()?;
            cfg.set_raw_value_by("remote", Some(name.as_bytes().as_bstr()), "url", url.as_bytes().as_bstr())?;
            crate::config::save(&cfg)?;
            Ok(0)
        }
        Some(other) => error(format!("unknown subcommand: {other}")),
    }
}
