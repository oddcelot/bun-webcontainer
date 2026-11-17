// Index writers: add, rm, reset, restore --staged. gix has no high-level `add`, so this drives the index API directly.
use crate::status::{Kind, load_index, worktree_changes};
use crate::{Ctx, Res, Specs, fatal, path_str, positional};
use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use std::collections::HashSet;

fn disk(path: &BStr) -> std::path::PathBuf {
    std::path::Path::new("/").join(path.to_str_lossy().as_ref())
}

/// Stage worktree changes matching `specs`: new files (if `untracked`), modifications and deletions.
/// Returns the amount of paths touched.
pub fn stage(ctx: &Ctx, specs: &Specs, untracked: bool) -> Result<usize, crate::Exit> {
    let mut index = load_index(ctx)?;
    let mut changes = worktree_changes(ctx, gix::status::UntrackedFiles::Files)?;
    // Conflicted paths: staging the file (or its absence) resolves them.
    for e in index.entries().iter().filter(|e| e.stage_raw() >= 2) {
        let path = e.path(&index).to_owned();
        if changes.iter().any(|w| w.path == path) {
            continue;
        }
        let kind = if std::fs::symlink_metadata(disk(path.as_ref())).is_ok() { Kind::Modified } else { Kind::Deleted };
        changes.push(crate::status::Wt { path, kind, is_dir: false, entry: Some((e.mode.bits(), e.id)) });
    }
    changes.retain(|w| (untracked || w.kind != Kind::Untracked) && specs.matches(&path_str(&w.path)));
    let touched: HashSet<BString> = changes.iter().map(|w| w.path.clone()).collect();
    index.remove_entries(|_, p, _| touched.contains(p));
    for w in &changes {
        if w.kind == Kind::Deleted {
            continue;
        }
        let p = disk(w.path.as_ref());
        let meta = gix::index::fs::Metadata::from_path_no_follow(&p)?;
        let (mode, data) = if meta.is_symlink() {
            (Mode::SYMLINK, std::fs::read_link(&p)?.to_string_lossy().into_owned().into_bytes())
        } else {
            let exec = w.entry.is_some_and(|(m, _)| m & 0o111 != 0);
            (if exec { Mode::FILE_EXECUTABLE } else { Mode::FILE }, std::fs::read(&p)?)
        };
        let id = ctx.repo.write_blob(&data)?.detach();
        index.dangerously_push_entry(Stat::from_fs(&meta)?, id, Flags::empty(), mode, w.path.as_ref());
    }
    index.sort_entries();
    if !changes.is_empty() {
        index.write(Default::default())?;
    }
    Ok(changes.len())
}

pub fn add(ctx: &Ctx, args: &[String]) -> Res {
    let tracked_only = args.iter().any(|a| a == "-u" || a == "--update");
    let all = args.iter().any(|a| a == "-A" || a == "--all");
    let mut paths = positional(args);
    if paths.is_empty() {
        if !all && !tracked_only {
            eprintln!("Nothing specified, nothing added.");
            return Ok(0);
        }
        paths.push(".".into());
    }
    let specs = Specs::new(&paths);
    // `git add <deleted path>` is fine: the match is against index entries too.
    let index = load_index(ctx)?;
    for e in index.entries() {
        specs.matches(&path_str(&e.path(&index).to_owned()));
    }
    let n = stage(ctx, &specs, !tracked_only)?;
    if n == 0 {
        specs.check_all_matched()?;
    }
    Ok(0)
}

pub fn rm(ctx: &Ctx, args: &[String]) -> Res {
    let cached = args.iter().any(|a| a == "--cached");
    let force = args.iter().any(|a| a == "-f" || a == "--force");
    let quiet = args.iter().any(|a| a == "-q" || a == "--quiet");
    let paths = positional(args);
    if paths.is_empty() {
        return fatal("No pathspec was given. Which files should I remove?");
    }
    let specs = Specs::new(&paths);
    let mut index = load_index(ctx)?;
    let mut gone: Vec<BString> = Vec::new();
    let mut edited: Vec<String> = Vec::new();
    for e in index.entries() {
        let p = e.path(&index);
        if specs.matches(&path_str(&p.to_owned())) && !gone.contains(&p.to_owned()) {
            gone.push(p.to_owned());
            // Like git: deleting a file whose content isn't in the index would lose those edits.
            if !cached && !force && e.stage_raw() == 0 {
                if let Ok(bytes) = std::fs::read(disk(p)) {
                    let id = gix::objs::compute_hash(e.id.kind(), gix::objs::Kind::Blob, &bytes);
                    if id.ok() != Some(e.id) {
                        edited.push(path_str(&p.to_owned()));
                    }
                }
            }
        }
    }
    specs.check_all_matched()?;
    if !edited.is_empty() {
        return crate::error(format!(
            "the following file{} local modifications:\n    {}\n(use --cached to keep the file, or -f to force removal)",
            if edited.len() == 1 { " has" } else { "s have" },
            edited.join("\n    ")
        ));
    }
    let set: HashSet<BString> = gone.iter().cloned().collect();
    index.remove_entries(|_, p, _| set.contains(p));
    index.write(Default::default())?;
    for p in &gone {
        if !quiet {
            crate::out(&format!("rm '{}'\n", path_str(p)));
        }
        if !cached {
            let _ = std::fs::remove_file(disk(p.as_ref()));
        }
    }
    Ok(0)
}
