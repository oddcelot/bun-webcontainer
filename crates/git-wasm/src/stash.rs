// `git stash`: push/save, list, show, apply, pop, drop, clear. The commits are shaped as git's, so native git reads
// them: w (the worktree's tracked files) with parents HEAD and i (the index, parent HEAD), and with -u a third parent u
// (the untracked files, a root commit). refs/stash's reflog is the list, newest last.
use crate::history::{short, signature, with_committer, write_tree};
use crate::merge::{apply_merged, conflict_messages};
use crate::status::{Flat, Kind, compute, flat_head, flat_index, flat_tree, load_index, long, unmerged, worktree_changes};
use crate::worktree::{hard_reset, remove_path, set_index, write_files};
use crate::{Ctx, Exit, Res, Specs, fatal, out, path_str};
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};

const LOG: &str = "/.git/logs/refs/stash";

/// A reflog line: `<old> <new> <committer> <time> <zone>\t<message>`.
struct Entry {
    new: ObjectId,
    /// everything after the two ids
    rest: String,
}

impl Entry {
    fn message(&self) -> &str {
        self.rest.split_once('\t').map_or("", |(_, m)| m)
    }
}

/// The stash list, oldest first (stash@{0} is the last).
fn entries() -> Vec<Entry> {
    let Ok(text) = std::fs::read_to_string(LOG) else { return Vec::new() };
    text.lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, ' ');
            let (_old, new, rest) = (parts.next()?, parts.next()?, parts.next()?);
            Some(Entry { new: ObjectId::from_hex(new.as_bytes()).ok()?, rest: rest.to_string() })
        })
        .collect()
}

/// Rewrite the reflog as `git reflog delete --rewrite --updateref` does: each entry's old id is the one before it, and
/// refs/stash points at the newest; with no entries left, both go.
fn write_entries(ctx: &Ctx, list: &[Entry]) -> Result<(), Exit> {
    let Some(last) = list.last() else {
        if let Some(r) = ctx.repo.try_find_reference("refs/stash")? {
            r.delete()?;
        }
        let _ = std::fs::remove_file(LOG);
        return Ok(());
    };
    let null = ObjectId::null(ctx.repo.object_hash());
    let mut text = String::new();
    let mut old = null;
    for e in list {
        text += &format!("{old} {} {}\n", e.new, e.rest);
        old = e.new;
    }
    std::fs::write(LOG, text)?;
    std::fs::write("/.git/refs/stash", format!("{}\n", last.new))?;
    Ok(())
}

fn no_entries<T>() -> Result<T, Exit> {
    Err(Exit { code: 128, msg: "No stash entries found.".into() })
}

/// `stash@{n}`, `n` or nothing (stash@{0}): the entry's position from the newest, and its name in messages.
fn pick(spec: Option<&String>, count: usize) -> Result<(usize, String), Exit> {
    if count == 0 {
        return no_entries();
    }
    let (n, name) = match spec.map(String::as_str) {
        None => (0, "refs/stash@{0}".to_string()),
        Some(s) if s.bytes().all(|b| b.is_ascii_digit()) && !s.is_empty() => (s.parse().unwrap_or(usize::MAX), format!("refs/stash@{{{s}}}")),
        Some(s) => {
            let n = s.strip_prefix("refs/").unwrap_or(s).strip_prefix("stash@{").and_then(|r| r.strip_suffix('}')).and_then(|n| n.parse().ok());
            match n {
                Some(n) => (n, s.to_string()),
                None => return Err(Exit { code: 128, msg: format!("error: {s} is not a valid reference") }),
            }
        }
    };
    if n >= count {
        let r = if name.starts_with("refs/") { "refs/stash" } else { "stash" };
        return fatal(format!("log for '{r}' only has {count} entries"));
    }
    Ok((n, name))
}

/// The stash commit's trees: the base (HEAD then), the index, the worktree, and the untracked files.
struct Stash {
    base: ObjectId,
    index: ObjectId,
    tree: ObjectId,
    untracked: Option<ObjectId>,
}

fn load(ctx: &Ctx, id: ObjectId) -> Result<Stash, Exit> {
    let c = ctx.repo.find_commit(id)?;
    let parents: Vec<ObjectId> = c.parent_ids().map(|p| p.detach()).collect();
    let tree_of = |id: ObjectId| -> Result<ObjectId, Exit> { Ok(ctx.repo.find_commit(id)?.tree_id()?.detach()) };
    let (Some(b), Some(i)) = (parents.first(), parents.get(1)) else { return fatal(format!("'{id}' is not a stash-like commit")) };
    Ok(Stash {
        base: tree_of(*b)?,
        index: tree_of(*i)?,
        tree: c.tree_id()?.detach(),
        untracked: parents.get(2).map(|u| tree_of(*u)).transpose()?,
    })
}

/// The untracked files (`-u`), with `-a` the ignored ones too (an ignored directory's files one by one).
fn untracked_files(ctx: &Ctx, ignored: bool) -> Result<Vec<BString>, Exit> {
    use gix::status::index_worktree::Item;
    let platform = ctx
        .repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .dirwalk_options(|o| o.emit_ignored(ignored.then_some(gix::dir::walk::EmissionMode::Matching)));
    let mut files = Vec::new();
    for item in platform.into_index_worktree_iter(Vec::<BString>::new())? {
        let Item::DirectoryContents { entry, .. } = item? else { continue };
        if !matches!(entry.status, gix::dir::entry::Status::Untracked | gix::dir::entry::Status::Ignored(_)) {
            continue;
        }
        if matches!(entry.disk_kind, Some(gix::dir::entry::Kind::Directory)) {
            walk(&crate::worktree::disk(entry.rela_path.as_ref()), &entry.rela_path, &mut files);
        } else {
            files.push(entry.rela_path);
        }
    }
    files.sort();
    Ok(files)
}

fn walk(dir: &std::path::Path, rel: &BString, files: &mut Vec<BString>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let mut p = rel.clone();
        p.push(b'/');
        p.extend_from_slice(e.file_name().to_string_lossy().as_bytes());
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            walk(&e.path(), &p, files);
        } else {
            files.push(p);
        }
    }
}

/// `implicit`: `git stash [<options>]` without `push`, which takes pathspecs only after `--`.
fn push(ctx: &Ctx, args: &[String], save: bool, implicit: bool) -> Res {
    let (mut msg, mut untracked, mut all, mut keep_index, mut quiet) = (None, false, false, false, false);
    let (mut words, mut paths, mut only_paths) = (Vec::new(), Vec::new(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            _ if only_paths => paths.push(a.clone()),
            "--" if !save => only_paths = true,
            "-m" | "--message" => msg = it.next().cloned(),
            // the later of -u and -a wins
            "-u" | "--include-untracked" => (untracked, all) = (true, false),
            "--no-include-untracked" => (untracked, all) = (false, false),
            "-a" | "--all" => (untracked, all) = (false, true),
            "-k" | "--keep-index" => keep_index = true,
            "--no-keep-index" => keep_index = false,
            "-q" | "--quiet" => quiet = true,
            a if a.starts_with("--message=") => msg = Some(a[10..].to_string()),
            a if a.starts_with("-m") && a.len() > 2 => msg = Some(a[2..].to_string()),
            "-p" | "--patch" | "-S" | "--staged" => return fatal(format!("stash {a} is not supported in the playground")),
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a if save => words.push(a.to_string()),
            a if implicit => return fatal(format!("subcommand wasn't specified; 'push' can't be assumed due to unexpected token '{a}'")),
            a => paths.push(a.to_string()),
        }
    }
    if save && !words.is_empty() {
        msg = Some(words.join(" "));
    }
    let Ok(head) = ctx.repo.head_commit() else {
        return Err(Exit { code: 1, msg: "You do not have the initial commit yet".into() });
    };
    let index = load_index(ctx)?;
    if !unmerged(&index).is_empty() {
        for p in unmerged(&index).keys() {
            eprintln!("{}: needs merge", p.to_str_lossy());
        }
        return fatal("could not save index tree");
    }
    let (h, idx) = (flat_head(ctx)?, flat_index(&index));
    let specs = Specs::new(&paths);
    let picked = |p: &BString| specs.matches(&path_str(p));
    let new_paths = if untracked || all { untracked_files(ctx, all)? } else { Vec::new() };
    // every pathspec must name something in the index (or, with -u/-a, an untracked file)
    if !paths.is_empty() {
        for p in idx.keys().chain(&new_paths) {
            picked(p);
        }
        if let Some(bad) = specs.unmatched() {
            return Err(Exit { code: 1, msg: format!("error: pathspec ':(prefix:0){bad}' did not match any file(s) known to git\nDid you forget to 'git add'?") });
        }
    }
    // the worktree's version of the tracked files (of those the pathspecs pick; the index's for the others)
    let mut w = idx.clone();
    for c in worktree_changes(ctx, gix::status::UntrackedFiles::None)? {
        if !picked(&c.path) {
            continue;
        }
        match c.kind {
            Kind::Deleted => {
                w.remove(&c.path);
            }
            Kind::Modified => {
                let id = ctx.repo.write_blob(std::fs::read(crate::worktree::disk(c.path.as_ref()))?)?.detach();
                w.insert(c.path.clone(), (c.entry.map_or(0o100644, |e| e.0), id));
            }
            Kind::Untracked => {}
        }
    }
    let mut new_files = Flat::new();
    for p in new_paths.into_iter().filter(|p| picked(p)) {
        let id = ctx.repo.write_blob(std::fs::read(crate::worktree::disk(p.as_ref()))?)?.detach();
        new_files.insert(p, (0o100644, id));
    }
    let staged = h.keys().chain(idx.keys()).any(|p| h.get(p) != idx.get(p) && picked(p));
    if !staged && w == idx && new_files.is_empty() {
        if !quiet {
            out("No local changes to save\n");
        }
        return Ok(0);
    }
    let branch = ctx.repo.head_name()?.map_or("(no branch)".to_string(), |n| n.shorten().to_str_lossy().into_owned());
    let subject = head.message_raw_sloppy().to_str_lossy().lines().next().unwrap_or("").to_string();
    let on = format!("{branch}: {} {subject}", short(head.id));
    let sig = signature(ctx);
    let commit = |message: String, tree: ObjectId, parents: Vec<ObjectId>| -> Result<ObjectId, Exit> {
        let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
        Ok(ctx.repo.new_commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), message, tree, parents)?.id)
    };
    // i is the whole index, also with pathspecs (as git's)
    let i = commit(format!("index on {on}\n"), write_tree(ctx, &idx)?, vec![head.id])?;
    let mut parents = vec![head.id, i];
    if !new_files.is_empty() {
        parents.push(commit(format!("untracked files on {on}\n"), write_tree(ctx, &new_files)?, Vec::new())?);
    }
    // git's w commit message has no trailing newline
    let message = match msg {
        Some(m) => format!("On {branch}: {m}"),
        None => format!("WIP on {on}"),
    };
    let id = commit(message.clone(), write_tree(ctx, &w)?, parents)?;
    with_committer(ctx)?.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange { mode: RefLog::AndReference, force_create_reflog: true, message: message.as_str().into() },
            expected: PreviousValue::Any,
            new: gix::refs::Target::Object(id),
        },
        name: "refs/stash".try_into()?,
        deref: false,
    })?;
    if !quiet {
        out(&format!("Saved working directory and index state {message}\n"));
    }
    for p in new_files.keys() {
        remove_path(p);
    }
    if paths.is_empty() {
        hard_reset(ctx, &h, true)?;
        if keep_index {
            hard_reset(ctx, &idx, true)?;
        }
        return Ok(0);
    }
    // only the picked paths go back to HEAD (with -k: to the index), in the index and the worktree
    let target = if keep_index { &idx } else { &h };
    let mut next = idx.clone();
    let mut files = Flat::new();
    for p in h.keys().chain(idx.keys()).filter(|p| picked(p)).cloned().collect::<std::collections::BTreeSet<_>>() {
        match target.get(&p) {
            Some(e) => {
                next.insert(p.clone(), *e);
                files.insert(p, *e);
            }
            None => {
                next.remove(&p);
                remove_path(&p);
            }
        }
    }
    set_index(ctx, &next)?;
    write_files(ctx, &files)?;
    Ok(0)
}

/// `stash branch <name> [<stash>]`: a new branch at the stash's base, the stash applied with `--index`, then dropped.
fn branch(ctx: &Ctx, args: &[String]) -> Res {
    let ops: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let Some(name) = ops.first() else {
        return Err(Exit { code: 128, msg: "No branch name specified".into() });
    };
    let list = entries();
    let (n, _) = pick(ops.get(1).copied(), list.len())?;
    let base = ctx.repo.find_commit(list[list.len() - 1 - n].new)?.parent_ids().next().map(|p| p.detach());
    let Some(base) = base else { return fatal("not a stash-like commit") };
    let code = crate::worktree::switch(ctx, &["-c".into(), name.to_string(), base.to_string()])?;
    if code != 0 {
        return Ok(code);
    }
    let mut rest = vec!["--index".to_string()];
    rest.extend(ops.get(1).map(|s| s.to_string()));
    apply(ctx, &rest, true)
}

fn list() -> Res {
    for (n, e) in entries().iter().rev().enumerate() {
        out(&format!("stash@{{{n}}}: {}\n", e.message()));
    }
    Ok(0)
}

fn show(ctx: &Ctx, args: &[String]) -> Res {
    let (mut patch, mut stat, mut spec) = (false, false, None);
    for a in args {
        match a.as_str() {
            "-p" | "-u" | "--patch" => patch = true,
            "--stat" => stat = true,
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            _ => spec = Some(a.clone()),
        }
    }
    let list = entries();
    let (n, _) = pick(spec.as_ref(), list.len())?;
    let s = load(ctx, list[list.len() - 1 - n].new)?;
    let (old, new) = (flat_tree(ctx, s.base)?, flat_tree(ctx, s.tree)?);
    if stat || !patch {
        out(&crate::diff::stat(ctx, &old, &new, false)?);
    }
    if patch {
        if stat {
            out("\n");
        }
        let (mut d, mut st) = (String::new(), crate::diff::Stats::default());
        crate::diff::diff_flats(ctx, &old, &new, &mut d, &mut st)?;
        out(&d);
    }
    Ok(0)
}

fn drop(ctx: &Ctx, spec: Option<&String>, quiet: bool) -> Res {
    let mut list = entries();
    let (n, name) = pick(spec, list.len())?;
    let e = list.remove(list.len() - 1 - n);
    write_entries(ctx, &list)?;
    if !quiet {
        out(&format!("Dropped {name} ({})\n", e.new));
    }
    Ok(0)
}

fn apply(ctx: &Ctx, args: &[String], pop: bool) -> Res {
    let (mut keep_index, mut quiet, mut spec) = (false, false, None);
    for a in args {
        match a.as_str() {
            "--index" => keep_index = true,
            "-q" | "--quiet" => quiet = true,
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            _ => spec = Some(a.clone()),
        }
    }
    let list = entries();
    let (n, _) = pick(spec.as_ref(), list.len())?;
    let s = load(ctx, list[list.len() - 1 - n].new)?;
    let index = load_index(ctx)?;
    let conflicted = unmerged(&index);
    if !conflicted.is_empty() {
        // refresh_index's report, then the index can't be written
        for p in conflicted.keys() {
            out(&format!("{}: needs merge\n", path_str(p)));
        }
        eprintln!("error: could not write index");
        if pop {
            out("The stash entry is kept in case you need it again.\n");
        }
        return Ok(128);
    }
    let current = flat_index(&index);
    let current_tree = write_tree(ctx, &current)?;
    let labels = |ours: &'static str, theirs: &'static str| gix::merge::blob::builtin_driver::text::Labels {
        ancestor: Some(BStr::new("Stash base")),
        current: Some(BStr::new(ours)),
        other: Some(BStr::new(theirs)),
    };
    // --index: the stashed index changes, merged onto the current index first
    let new_index = if keep_index && s.index != s.base {
        let mut o = ctx.repo.merge_trees(s.base, current_tree, s.index, labels("Updated upstream", "Stashed changes"), ctx.repo.tree_merge_options()?)?;
        if o.has_unresolved_conflicts(gix::merge::tree::TreatAsUnresolved::git()) {
            return Err(Exit { code: 128, msg: "error: conflicts in index. Try without --index.".into() });
        }
        Some(flat_tree(ctx, o.tree.write()?.detach())?)
    } else {
        None
    };
    let mut outcome = ctx.repo.merge_trees(s.base, current_tree, s.tree, labels("Updated upstream", "Stashed changes"), ctx.repo.tree_merge_options()?)?;
    let merged = flat_tree(ctx, outcome.tree.write()?.detach())?;
    let conflicted = match apply_merged(ctx, &current, &merged, &outcome) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", e.msg);
            if keep_index {
                eprintln!("Index was not unstashed.");
            }
            if !quiet {
                out(&long(ctx, &compute(ctx)?)?);
            }
            return Ok(128);
        }
    };
    for line in conflict_messages(&outcome.conflicts, "Updated upstream", "Stashed changes") {
        out(&format!("{line}\n"));
    }
    if conflicted && keep_index {
        eprintln!("Index was not unstashed.");
    }
    if !conflicted {
        match new_index {
            Some(t) => set_index(ctx, &t)?,
            None => {
                // the stash's changes come back unstaged, but for files that are new (unstage_changes_unless_new)
                let mut t = merged.clone();
                t.extend(current.iter().map(|(p, e)| (p.clone(), *e)));
                set_index(ctx, &t)?;
            }
        }
    }
    // the untracked files, but for ones that are back in the worktree since (then it fails, as git does)
    let mut code = 0;
    if let Some(u) = s.untracked {
        let mut files = flat_tree(ctx, u)?;
        files.retain(|p, _| {
            let taken = crate::worktree::disk(p.as_ref()).exists();
            if taken {
                eprintln!("{} already exists, no checkout", p.to_str_lossy());
            }
            !taken
        });
        write_files(ctx, &files)?;
        if files.len() < flat_tree(ctx, u)?.len() {
            eprintln!("error: could not restore untracked files from stash");
            code = 128;
        }
    }
    if !quiet {
        out(&long(ctx, &compute(ctx)?)?);
    }
    if code != 0 {
        return Ok(code);
    }
    if conflicted {
        if pop {
            out("The stash entry is kept in case you need it again.\n");
        }
        return Ok(1);
    }
    if pop {
        return drop(ctx, spec.as_ref(), quiet);
    }
    Ok(0)
}

pub fn stash(ctx: &Ctx, args: &[String]) -> Res {
    let (sub, rest, implicit) = match args.first() {
        Some(a) if !a.starts_with('-') => (a.as_str(), &args[1..], false),
        _ => ("push", args, true),
    };
    let spec = rest.iter().find(|a| !a.starts_with('-'));
    let quiet = rest.iter().any(|a| a == "-q" || a == "--quiet");
    match sub {
        "push" => push(ctx, rest, false, implicit),
        "save" => push(ctx, rest, true, false),
        "list" => list(),
        "show" => show(ctx, rest),
        "apply" => apply(ctx, rest, false),
        "pop" => apply(ctx, rest, true),
        "drop" => drop(ctx, spec, quiet),
        "branch" => branch(ctx, rest),
        "clear" => write_entries(ctx, &[]).map(|_| 0),
        _ => Err(Exit { code: 129, msg: format!("error: unknown subcommand: `{sub}'") }),
    }
}
