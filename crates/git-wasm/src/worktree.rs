// Commands that move HEAD, the index and the worktree: switch, checkout, restore, reset, clean. The worktree is written
// from blobs directly (no filters or autocrlf: the playground has none), so gix's `worktree-mutation` isn't needed.
use crate::history::short;
use crate::status::{Flat, Kind, flat_head, flat_index, flat_tree, load_index, worktree_changes};
use crate::{Ctx, Exit, Res, Specs, error, fatal, out, path_str};
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use gix::refs::Target;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

pub fn disk(path: &BStr) -> PathBuf {
    Path::new("/").join(path.to_str_lossy().as_ref())
}

fn commit_of<'r>(ctx: &'r Ctx, spec: &str) -> Option<gix::Commit<'r>> {
    ctx.repo.rev_parse_single(spec).ok()?.object().ok()?.peel_to_commit().ok()
}

pub fn commit_flat(ctx: &Ctx, c: &gix::Commit<'_>) -> Result<Flat, Exit> {
    flat_tree(ctx, c.tree_id()?.detach())
}

fn subject(c: &gix::Commit<'_>) -> String {
    c.message_raw_sloppy().to_str_lossy().lines().next().unwrap_or("").to_string()
}

// ---- worktree and index primitives -------------------------------------------------------------------------------

fn make_dirs(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => std::fs::remove_file(dir)?, // a file where a directory must go (it was tracked, or checked by the caller)
        Err(_) => {
            if let Some(parent) = dir.parent() {
                make_dirs(parent)?;
            }
        }
    }
    std::fs::create_dir(dir)
}

/// Write the blob to the worktree (replacing a file or an empty directory) and return its stat for the index.
fn write_entry(ctx: &Ctx, path: &BString, mode: u32, id: ObjectId) -> Result<Stat, Exit> {
    let p = disk(path.as_ref());
    if mode & 0o170000 == 0o160000 {
        make_dirs(&p)?; // a gitlink is an empty directory
        return Ok(Stat::default());
    }
    let data = ctx.repo.find_object(id)?.detach().data;
    if let Some(parent) = p.parent() {
        make_dirs(parent)?;
    }
    if p.is_dir() {
        std::fs::remove_dir(&p)?;
    }
    // A symlink (120000) is written as a file holding its target: the playground FS has no symlinks.
    std::fs::write(&p, &data)?;
    Ok(Stat::from_fs(&gix::index::fs::Metadata::from_path_no_follow(&p)?)?)
}

/// Remove a file and the directories it leaves empty.
pub fn remove_path(path: &BString) {
    let p = disk(path.as_ref());
    let _ = std::fs::remove_file(&p);
    let mut dir = p.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == Path::new("/") || std::fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

fn disk_matches(ctx: &Ctx, path: &BString, id: ObjectId) -> bool {
    std::fs::read(disk(path.as_ref()))
        .ok()
        .is_some_and(|b| gix::objs::compute_hash(ctx.repo.object_hash(), gix::objs::Kind::Blob, &b).ok() == Some(id))
}

type Add = (BString, u32, ObjectId, Stat);

fn rewrite_index(ctx: &Ctx, drop: &HashSet<BString>, add: &[Add]) -> Result<(), Exit> {
    let mut index = load_index(ctx)?;
    index.remove_entries(|_, p, _| drop.contains(p));
    for (p, mode, id, stat) in add {
        let mode = Mode::from_bits(*mode).unwrap_or(Mode::FILE);
        index.dangerously_push_entry(*stat, *id, Flags::empty(), mode, p.as_ref());
    }
    index.sort_entries();
    index.remove_tree(); // the cached tree no longer matches
    index.write(Default::default())?;
    Ok(())
}

// ---- refs ---------------------------------------------------------------------------------------------------------

fn edit_head(ctx: &Ctx, target: Target, deref: bool, msg: &str) -> Result<(), Exit> {
    let repo = crate::history::with_committer(ctx)?;
    repo.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: msg.into() },
            expected: PreviousValue::Any,
            new: target,
        },
        name: "HEAD".try_into()?,
        deref,
    })?;
    Ok(())
}

/// Point HEAD at a branch (it may be unborn).
pub fn set_head_branch(ctx: &Ctx, branch: &str, msg: &str) -> Result<(), Exit> {
    edit_head(ctx, Target::Symbolic(format!("refs/heads/{branch}").try_into()?), false, msg)
}

/// Move the branch HEAD is on (or HEAD itself, when detached).
pub fn move_head(ctx: &Ctx, id: ObjectId, msg: &str) -> Result<(), Exit> {
    edit_head(ctx, Target::Object(id), true, msg)
}

fn detach_head(ctx: &Ctx, id: ObjectId, msg: &str) -> Result<(), Exit> {
    edit_head(ctx, Target::Object(id), false, msg)
}

fn branch_exists(ctx: &Ctx, name: &str) -> bool {
    ctx.repo.try_find_reference(format!("refs/heads/{name}").as_str()).ok().flatten().is_some()
}

// ---- moving between trees -----------------------------------------------------------------------------------------

/// `<dir>` holds a file that isn't about to be removed.
fn dir_has_foreign(dir: &Path, prefix: &str, removed: &HashSet<BString>) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return true };
    rd.flatten().any(|e| {
        let rel = format!("{prefix}/{}", e.file_name().to_string_lossy());
        if e.path().is_dir() { dir_has_foreign(&e.path(), &rel, removed) } else { !removed.contains(&BString::from(rel)) }
    })
}

/// Something untracked sits where `p` would be written: the path itself, or a file in place of a parent directory.
fn blocked(p: &BString, removed: &HashSet<BString>) -> bool {
    let s = path_str(p);
    if let Ok(m) = std::fs::symlink_metadata(disk(p.as_ref())) {
        return if m.is_dir() { dir_has_foreign(&disk(p.as_ref()), &s, removed) } else { true };
    }
    let mut at = 0;
    while let Some(i) = s[at..].find('/') {
        at += i;
        let parent = &s[..at];
        if std::fs::symlink_metadata(Path::new("/").join(parent)).is_ok_and(|m| !m.is_dir()) && !removed.contains(&BString::from(parent)) {
            return true;
        }
        at += 1;
    }
    false
}

/// `git checkout <branch>`'s two-way merge: paths that differ between HEAD and `t` are replaced when the index and the
/// worktree still hold HEAD's version; everything else, local changes included, is carried over. Refuses, touching
/// nothing, when a change or an untracked file is in the way.
fn switch_tree(ctx: &Ctx, t: &Flat) -> Result<(), Exit> {
    let index = load_index(ctx)?;
    let conflicts = crate::status::unmerged(&index);
    if !conflicts.is_empty() {
        for p in conflicts.keys() {
            out(&format!("{}: needs merge\n", path_str(p)));
        }
        return error("you need to resolve your current index first");
    }
    two_way(ctx, &flat_head(ctx)?, t, "checkout")
}

/// The two-way merge from `h` (what the index is expected to hold) to `t`, as `switch_tree` describes; `verb` names
/// the command in the refusal (`checkout`, `merge`).
pub fn two_way(ctx: &Ctx, h: &Flat, t: &Flat, verb: &str) -> Result<(), Exit> {
    let idx = flat_index(&load_index(ctx)?);
    let paths: BTreeSet<&BString> = h.keys().chain(t.keys()).filter(|p| h.get(*p) != t.get(*p)).collect();
    let removed: HashSet<BString> =
        paths.iter().filter(|p| t.get(**p).is_none() && h.get(**p).is_some() && idx.get(**p) == h.get(**p)).map(|p| (*p).clone()).collect();
    let (mut tracked, mut untracked, mut todo) = (Vec::new(), Vec::new(), Vec::new());
    for p in paths {
        let (i, hh, tt) = (idx.get(p), h.get(p), t.get(p));
        if i == tt {
            continue; // the index has it already
        }
        if i != hh {
            tracked.push(path_str(p));
        } else if let Some((_, id)) = i {
            if std::fs::symlink_metadata(disk(p.as_ref())).is_ok() && !disk_matches(ctx, p, *id) {
                tracked.push(path_str(p));
            } else {
                todo.push(p);
            }
        } else if blocked(p, &removed) {
            untracked.push(path_str(p));
        } else {
            todo.push(p);
        }
    }
    let mut msg = Vec::new();
    let before = if verb == "checkout" { "switch branches" } else { verb };
    if !tracked.is_empty() {
        msg.push(format!(
            "error: Your local changes to the following files would be overwritten by {verb}:\n\t{}\nPlease commit your changes or stash them before you {before}.\nAborting",
            tracked.join("\n\t")
        ));
    }
    if !untracked.is_empty() {
        msg.push(format!(
            "error: The following untracked working tree files would be overwritten by {verb}:\n\t{}\nPlease move or remove them before you {before}.\nAborting",
            untracked.join("\n\t")
        ));
    }
    if !msg.is_empty() {
        return Err(Exit { code: 1, msg: msg.join("\n") });
    }
    let (mut drop, mut add) = (HashSet::new(), Vec::new());
    for p in &todo {
        if t.get(*p).is_none() {
            remove_path(p);
        }
    }
    for p in todo {
        drop.insert(p.clone());
        if let Some((mode, id)) = t.get(p) {
            add.push((p.clone(), *mode, *id, write_entry(ctx, p, *mode, *id)?));
        }
    }
    rewrite_index(ctx, &drop, &add)
}

/// Make the index (and with `worktree` the tracked files) equal to `t`, discarding changes. Untracked files stay.
pub fn hard_reset(ctx: &Ctx, t: &Flat, worktree: bool) -> Result<(), Exit> {
    let index = load_index(ctx)?;
    let (idx, conflicts) = (flat_index(&index), crate::status::unmerged(&index));
    let paths: BTreeSet<&BString> = idx.keys().chain(t.keys()).chain(conflicts.keys()).collect();
    let (mut drop, mut add) = (HashSet::new(), Vec::new());
    for p in paths {
        let tt = t.get(p);
        let mut stat = Stat::default();
        let mut rewrite = idx.get(p) != tt || conflicts.contains_key(p);
        match tt {
            Some((mode, id)) => {
                if worktree && !disk_matches(ctx, p, *id) {
                    stat = write_entry(ctx, p, *mode, *id)?;
                    rewrite = true;
                }
                if rewrite {
                    add.push((p.clone(), *mode, *id, stat));
                }
            }
            None if worktree => remove_path(p),
            None => {}
        }
        if rewrite {
            drop.insert(p.clone());
        }
    }
    rewrite_index(ctx, &drop, &add)
}

/// `reset --merge` to HEAD: the paths whose index entry differs from HEAD (conflicts included) get HEAD's version in
/// the index and the worktree; local changes to other paths stay.
pub fn reset_merge(ctx: &Ctx) -> Result<(), Exit> {
    let index = load_index(ctx)?;
    let (h, idx, conflicts) = (flat_head(ctx)?, flat_index(&index), crate::status::unmerged(&index));
    let paths: BTreeSet<&BString> =
        h.keys().chain(idx.keys()).chain(conflicts.keys()).filter(|p| h.get(*p) != idx.get(*p) || conflicts.contains_key(*p)).collect();
    let (mut drop, mut add) = (HashSet::new(), Vec::new());
    for p in paths {
        drop.insert(p.clone());
        match h.get(p) {
            Some((mode, id)) => add.push((p.clone(), *mode, *id, write_entry(ctx, p, *mode, *id)?)),
            None => remove_path(p),
        }
    }
    rewrite_index(ctx, &drop, &add)
}

/// Write the files of `t` into the worktree (not the index), for `stash`'s untracked files.
pub fn write_files(ctx: &Ctx, t: &Flat) -> Result<(), Exit> {
    for (p, (mode, id)) in t {
        write_entry(ctx, p, *mode, *id)?;
    }
    Ok(())
}

/// Set the index to `t` (stage 0 only), keeping the stat of entries that stay the same; the worktree isn't touched.
pub fn set_index(ctx: &Ctx, t: &Flat) -> Result<(), Exit> {
    let index = load_index(ctx)?;
    let (idx, conflicts) = (flat_index(&index), crate::status::unmerged(&index));
    let paths: BTreeSet<&BString> = idx.keys().chain(t.keys()).chain(conflicts.keys()).filter(|p| idx.get(*p) != t.get(*p) || conflicts.contains_key(*p)).collect();
    let (mut drop, mut add) = (HashSet::new(), Vec::new());
    for p in paths {
        drop.insert(p.clone());
        if let Some((mode, id)) = t.get(p) {
            add.push((p.clone(), *mode, *id, Stat::default()));
        }
    }
    rewrite_index(ctx, &drop, &add)
}


// ---- switch / checkout --------------------------------------------------------------------------------------------

struct Opts {
    create: Option<String>,
    detach: bool,
    force: bool,
    pos: Vec<String>,
    /// arguments after `--`, when it was given
    paths: Option<Vec<String>>,
}

fn parse(args: &[String], checkout: bool) -> Result<Opts, Exit> {
    let mut o = Opts { create: None, detach: false, force: false, pos: Vec::new(), paths: None };
    let mut it = args.iter();
    let want = |it: &mut std::slice::Iter<String>, flag: &str| {
        it.next().cloned().ok_or(Exit { code: 129, msg: format!("error: switch `{flag}' requires a value") })
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--" => o.paths = Some(it.by_ref().cloned().collect()),
            "-c" | "--create" if !checkout => o.create = Some(want(&mut it, "c")?),
            "-b" if checkout => o.create = Some(want(&mut it, "b")?),
            "-d" | "--detach" => o.detach = true,
            "-f" | "--force" | "--discard-changes" => o.force = true,
            "-q" | "--quiet" => {}
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => o.pos.push(a.to_string()),
        }
    }
    Ok(o)
}

pub fn move_to(ctx: &Ctx, target: &gix::Commit<'_>, force: bool) -> Result<(), Exit> {
    let t = commit_flat(ctx, target)?;
    if force { hard_reset(ctx, &t, true) } else { switch_tree(ctx, &t) }
}

fn from_label(ctx: &Ctx) -> String {
    match ctx.repo.head_name() {
        Ok(Some(n)) => n.shorten().to_str_lossy().into_owned(),
        _ => ctx.repo.head_id().map(|i| short(i.detach())).unwrap_or_else(|_| "HEAD".into()),
    }
}

fn switch_branch(ctx: &Ctx, o: &Opts) -> Res {
    let from = from_label(ctx);
    if let Some(new) = &o.create {
        if branch_exists(ctx, new) {
            return fatal(format!("a branch named '{new}' already exists"));
        }
        let start = o.pos.first().map(String::as_str).unwrap_or("HEAD");
        match commit_of(ctx, start) {
            Some(c) => {
                move_to(ctx, &c, o.force)?;
                let repo = crate::history::with_committer(ctx)?;
                repo.reference(format!("refs/heads/{new}"), c.id, PreviousValue::MustNotExist, format!("branch: Created from {start}"))?;
            }
            None if start == "HEAD" => {} // unborn: the branch is created by the first commit
            None => return fatal(format!("invalid reference: {start}")),
        }
        set_head_branch(ctx, new, &format!("checkout: moving from {from} to {new}"))?;
        eprintln!("Switched to a new branch '{new}'");
        return Ok(0);
    }
    let Some(name) = o.pos.first() else { return fatal("missing branch or commit argument") };
    if !o.detach && branch_exists(ctx, name) {
        if ctx.repo.head_name()?.is_some_and(|n| n.shorten() == name.as_str()) {
            eprintln!("Already on '{name}'");
            return Ok(0);
        }
        let c = commit_of(ctx, &format!("refs/heads/{name}")).ok_or_else(|| Exit { code: 128, msg: format!("fatal: invalid reference: {name}") })?;
        move_to(ctx, &c, o.force)?;
        set_head_branch(ctx, name, &format!("checkout: moving from {from} to {name}"))?;
        eprintln!("Switched to branch '{name}'");
        return Ok(0);
    }
    let Some(c) = commit_of(ctx, name) else { return fatal(format!("invalid reference: {name}")) };
    if !o.detach {
        return fatal(format!("a branch is expected, got '{name}'"));
    }
    detach(ctx, &c, &from, o.force)
}

fn detach(ctx: &Ctx, c: &gix::Commit<'_>, from: &str, force: bool) -> Res {
    move_to(ctx, c, force)?;
    detach_head(ctx, c.id, &format!("checkout: moving from {from} to {}", short(c.id)))?;
    eprintln!("HEAD is now at {} {}", short(c.id), subject(c));
    Ok(0)
}

pub fn switch(ctx: &Ctx, args: &[String]) -> Res {
    let o = parse(args, false)?;
    if crate::status::merging() {
        return fatal("cannot switch branch while merging\nConsider \"git merge --quit\" or \"git worktree add\".");
    }
    switch_branch(ctx, &o)
}

pub fn checkout(ctx: &Ctx, args: &[String]) -> Res {
    let o = parse(args, true)?;
    let from = from_label(ctx);
    if let Some(paths) = &o.paths {
        // git checkout [<rev>] -- <path>...: from the index, or from <rev> into the index and the worktree
        if paths.is_empty() {
            return fatal("you must specify path(s) to restore");
        }
        return match o.pos.first() {
            Some(rev) => {
                let Some(c) = commit_of(ctx, rev) else { return fatal(format!("invalid reference: {rev}")) };
                restore_paths(ctx, &Specs::new(paths), Some(commit_flat(ctx, &c)?), true, true, false)
            }
            None => restore_paths(ctx, &Specs::new(paths), None, false, true, false),
        };
    }
    if o.create.is_some() {
        return switch_branch(ctx, &o);
    }
    let Some(first) = o.pos.first() else { return Ok(0) };
    if o.pos.len() == 1 && !o.detach && branch_exists(ctx, first) {
        return switch_branch(ctx, &o);
    }
    if let Some(c) = commit_of(ctx, first) {
        if o.pos.len() > 1 {
            return restore_paths(ctx, &Specs::new(&o.pos[1..]), Some(commit_flat(ctx, &c)?), true, true, false);
        }
        return detach(ctx, &c, &from, o.force);
    }
    restore_paths(ctx, &Specs::new(&o.pos), None, false, true, false)
}

// ---- restore / reset ----------------------------------------------------------------------------------------------

/// Copy the paths matching `specs` from `source` (default: HEAD for `staged`, else the index) into the index and/or
/// the worktree. A path the source lacks is removed from the targets.
pub fn restore_paths(ctx: &Ctx, specs: &Specs, source: Option<Flat>, staged: bool, worktree: bool, remove_missing: bool) -> Res {
    let idx = flat_index(&load_index(ctx)?);
    let src = match source {
        Some(s) => s,
        None if staged => flat_head(ctx)?,
        None => idx.clone(),
    };
    let paths: BTreeSet<&BString> =
        src.keys().chain(idx.keys()).filter(|p| (remove_missing || src.contains_key(*p)) && specs.matches(&path_str(p))).collect();
    if let Some(bad) = specs.unmatched() {
        return error(format!("pathspec '{bad}' did not match any file(s) known to git"));
    }
    let (mut drop, mut add) = (HashSet::new(), Vec::new());
    for p in paths {
        let entry = src.get(p);
        let mut stat = Stat::default();
        let mut written = false;
        match entry {
            Some((mode, id)) if worktree && !disk_matches(ctx, p, *id) => {
                stat = write_entry(ctx, p, *mode, *id)?;
                written = true;
            }
            None if worktree => remove_path(p),
            _ => {}
        }
        // The index changes with --staged; otherwise only the stat of an entry whose file was just rewritten.
        if staged || (written && idx.get(p) == entry) {
            drop.insert(p.clone());
            if let Some((mode, id)) = entry {
                add.push((p.clone(), *mode, *id, stat));
            }
        }
    }
    if !drop.is_empty() {
        rewrite_index(ctx, &drop, &add)?;
    }
    Ok(0)
}

pub fn restore(ctx: &Ctx, args: &[String]) -> Res {
    let (mut staged, mut worktree, mut source) = (false, false, None);
    let mut paths = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-S" | "--staged" => staged = true,
            "-W" | "--worktree" => worktree = true,
            "-s" | "--source" => source = it.next().cloned(),
            "--" => paths.extend(it.by_ref().cloned()),
            "-q" | "--quiet" => {}
            a if a.starts_with("--source=") => source = Some(a[9..].to_string()),
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => paths.push(a.to_string()),
        }
    }
    if paths.is_empty() {
        return fatal("you must specify path(s) to restore");
    }
    if !staged {
        worktree = true;
    }
    let source = match source {
        Some(rev) => match commit_of(ctx, &rev) {
            Some(c) => Some(commit_flat(ctx, &c)?),
            None => return fatal(format!("could not resolve {rev}")),
        },
        None => None,
    };
    restore_paths(ctx, &Specs::new(&paths), source, staged, worktree, true)
}

pub fn reset(ctx: &Ctx, args: &[String]) -> Res {
    let mut mode = "mixed";
    let (mut pos, mut after) = (Vec::new(), None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--soft" => mode = "soft",
            "--mixed" => mode = "mixed",
            "--hard" => mode = "hard",
            "-q" | "--quiet" => {}
            "--" => after = Some(it.by_ref().cloned().collect::<Vec<_>>()),
            "--merge" | "--keep" => {
                eprintln!("git: 'reset {a}' is not supported in the playground");
                return Ok(1);
            }
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => pos.push(a.to_string()),
        }
    }
    // `git reset [<rev>] [--] [<path>...]`: the first argument is a rev if it resolves to a commit (or `--` follows).
    let mut rev = None;
    if let Some(first) = pos.first() {
        if let Some(c) = commit_of(ctx, first) {
            rev = Some(c);
            pos.remove(0);
        } else if after.is_some() || std::fs::symlink_metadata(disk(first.as_str().into())).is_err() {
            return fatal(format!("ambiguous argument '{first}': unknown revision or path not in the working tree."));
        }
    }
    let paths: Vec<String> = pos.into_iter().chain(after.unwrap_or_default()).collect();
    let head = ctx.repo.head_commit().ok();
    if !paths.is_empty() {
        if args.iter().any(|a| a == "--soft" || a == "--hard") {
            return fatal(format!("Cannot do {mode} reset with paths."));
        }
        let src = match rev.as_ref().or(head.as_ref()) {
            Some(c) => commit_flat(ctx, c)?,
            None => Flat::new(),
        };
        return restore_paths(ctx, &Specs::new(&paths), Some(src), true, false, true);
    }
    let Some(target) = rev.or(head) else {
        if mode == "mixed" {
            return restore_paths(ctx, &Specs::new(&[]), Some(Flat::new()), true, false, true); // unborn: empties the index
        }
        return fatal("Failed to resolve 'HEAD' as a valid ref.");
    };
    if mode == "soft" && crate::status::merging() {
        return fatal("Cannot do a soft reset in the middle of a merge.");
    }
    if mode != "soft" {
        hard_reset(ctx, &commit_flat(ctx, &target)?, mode == "hard")?;
    }
    crate::merge::clear_state();
    let orig = ctx.repo.head_id().ok().map(|i| i.detach());
    let to = args.iter().find(|a| !a.starts_with('-')).map_or("HEAD", String::as_str);
    move_head(ctx, target.id, &format!("reset: moving to {to}"))?;
    if let Some(orig) = orig {
        crate::merge::write_state("ORIG_HEAD", &format!("{orig}\n"))?;
    }
    if mode == "hard" {
        out(&format!("HEAD is now at {} {}\n", short(target.id), subject(&target)));
    }
    Ok(0)
}

// ---- clean --------------------------------------------------------------------------------------------------------

pub fn clean(ctx: &Ctx, args: &[String]) -> Res {
    let (mut dry, mut force, mut dirs) = (false, false, false);
    let mut paths = Vec::new();
    for a in args {
        match a.as_str() {
            "--dry-run" => dry = true,
            "--force" => force = true,
            "--quiet" | "--" => {}
            // short flags, possibly combined: -n, -f, -d, -fd
            a if a.starts_with('-') && !a.starts_with("--") && a.len() > 1 && a[1..].chars().all(|c| "nfdq".contains(c)) => {
                (dry, force, dirs) = (dry || a.contains('n'), force || a.contains('f'), dirs || a.contains('d'));
            }
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => paths.push(a.to_string()),
        }
    }
    if !dry && !force {
        return fatal("clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean");
    }
    let specs = Specs::new(&paths);
    for w in worktree_changes(ctx, gix::status::UntrackedFiles::Collapsed)? {
        let p = path_str(&w.path);
        if w.kind != Kind::Untracked || (w.is_dir && !dirs) || !specs.matches(&p) {
            continue;
        }
        let shown = crate::status::quote_path(&format!("{p}{}", if w.is_dir { "/" } else { "" }), false);
        out(&format!("{} {shown}\n", if dry { "Would remove" } else { "Removing" }));
        if !dry {
            let d = disk(w.path.as_ref());
            let _ = if w.is_dir { std::fs::remove_dir_all(&d) } else { std::fs::remove_file(&d) };
        }
    }
    Ok(0)
}
