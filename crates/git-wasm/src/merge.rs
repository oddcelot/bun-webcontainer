// `git merge`: fast-forwards, and true merges with gix's merge machinery (gix-merge, merge-ort's results: the merged
// tree with conflict markers in the conflicting files, the index's conflict stages, MERGE_HEAD and MERGE_MSG).
use crate::history::short;
use crate::status::{Flat, flat_index, flat_tree, load_index, merging, unmerged};
use crate::worktree::{commit_flat, move_head, two_way};
use crate::{Ctx, Exit, Res, fatal, out, path_str};
use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use gix::merge::tree::{Conflict, Resolution, ResolutionFailure, TreatAsUnresolved, apply_index_entries::RemovalMode};

const STATE: [&str; 4] = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"];

pub fn write_state(name: &str, text: &str) -> Result<(), Exit> {
    std::fs::write(format!("/.git/{name}"), text)?;
    Ok(())
}

/// Forget a merge in progress (as `reset` and the merge commit do).
pub fn clear_state() {
    for name in STATE {
        let _ = std::fs::remove_file(format!("/.git/{name}"));
    }
}

/// The merge in progress: the commits in MERGE_HEAD and the message prepared in MERGE_MSG.
pub fn merge_heads() -> Result<(Vec<ObjectId>, Option<String>), Exit> {
    let heads = std::fs::read_to_string("/.git/MERGE_HEAD")?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| ObjectId::from_hex(l.trim().as_bytes()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((heads, std::fs::read_to_string("/.git/MERGE_MSG").ok()))
}

const UNMERGED: &str = "error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.";

/// What `name` refers to, for the merge message (fmt-merge-msg): `branch 'feat'`, `tag 'v1'`,
/// `remote-tracking branch 'origin/main'`, `commit '<name>'`, and an annotated tag's message.
fn describe(ctx: &Ctx, name: &str) -> (String, Option<String>) {
    let find = |full: String| ctx.repo.try_find_reference(full.as_str()).ok().flatten();
    if find(format!("refs/heads/{name}")).is_some() {
        return (format!("branch '{name}'"), None);
    }
    if let Some(r) = find(format!("refs/tags/{name}")) {
        let message = match r.target().try_id().map(|id| ctx.repo.find_object(id)) {
            Some(Ok(o)) if o.kind == gix::object::Kind::Tag => o.try_into_tag().ok().and_then(|t| t.decode().ok().map(|t| t.message.to_str_lossy().trim().to_string())),
            _ => None,
        };
        return (format!("tag '{name}'"), message.filter(|m| !m.is_empty()));
    }
    if find(format!("refs/remotes/{name}")).is_some() {
        return (format!("remote-tracking branch '{name}'"), None);
    }
    (format!("commit '{name}'"), None)
}

fn default_message(ctx: &Ctx, name: &str) -> Result<String, Exit> {
    let (what, tag_message) = describe(ctx, name);
    let mut msg = format!("Merge {what}");
    match ctx.repo.head_name()? {
        Some(b) if !matches!(b.shorten().to_str_lossy().as_ref(), "main" | "master") => msg += &format!(" into {}", b.shorten()),
        None => msg += " into HEAD",
        _ => {}
    }
    if let Some(m) = tag_message {
        msg += &format!("\n\n{m}");
    }
    Ok(msg)
}

/// merge-ort's messages for the conflicts (and the clean content merges): `Auto-merging a.txt`,
/// `CONFLICT (content): Merge conflict in a.txt`, by path.
pub fn conflict_messages(conflicts: &[Conflict], ours_label: &str, theirs_label: &str) -> Vec<String> {
    use gix::diff::tree_with_rewrites::Change;
    let mut lines: Vec<(String, Vec<String>)> = Vec::new();
    for c in conflicts {
        let path = path_str(&c.ours.location().to_owned());
        let mut l = Vec::new();
        match &c.resolution {
            Ok(Resolution::OursModifiedTheirsModifiedThenBlobContentMerge { merged_blob }) => {
                l.push(format!("Auto-merging {path}"));
                if matches!(merged_blob.resolution, gix::merge::blob::Resolution::Conflict) {
                    let kind = if matches!((&c.ours, &c.theirs), (Change::Addition { .. }, Change::Addition { .. })) { "add/add" } else { "content" };
                    l.push(format!("CONFLICT ({kind}): Merge conflict in {path}"));
                }
            }
            Ok(_) => {}
            Err(ResolutionFailure::OursModifiedTheirsDeleted) => {
                let (deleted_by, kept) = if matches!(c.ours, Change::Deletion { .. }) { (ours_label, theirs_label) } else { (theirs_label, ours_label) };
                let path = if matches!(c.ours, Change::Deletion { .. }) { path_str(&c.theirs.location().to_owned()) } else { path.clone() };
                l.push(format!("CONFLICT (modify/delete): {path} deleted in {deleted_by} and modified in {kept}.  Version {kept} of {path} left in tree."));
            }
            Err(f) => l.push(format!("CONFLICT ({}): Merge conflict in {path}", failure_kind(f))),
        }
        lines.push((path, l));
    }
    lines.sort_by(|a, b| a.0.cmp(&b.0));
    lines.into_iter().flat_map(|(_, l)| l).collect()
}

fn failure_kind(f: &ResolutionFailure) -> &'static str {
    match f {
        ResolutionFailure::OursRenamedTheirsRenamedDifferently { .. } | ResolutionFailure::OursRenamedTheirsRenamedToSameLocation => "rename/rename",
        ResolutionFailure::OursDeletedTheirsRenamed => "rename/delete",
        ResolutionFailure::OursAddedTheirsAddedTypeMismatch { .. } => "distinct types",
        ResolutionFailure::OursModifiedTheirsDirectoryThenOursRenamed { .. } | ResolutionFailure::OursDirectoryTheirsNonDirectoryTheirsRenamed { .. } => "file/directory",
        ResolutionFailure::SubmoduleMerge | ResolutionFailure::SubmoduleAddAdd => "submodule",
        _ => "content",
    }
}

/// Apply a merged tree to the index and the worktree: the two-way merge from `from` (what the index holds) to `merged`,
/// then the conflicts' stages. Refuses (`Err`) when local changes or untracked files are in the way.
pub fn apply_merged(ctx: &Ctx, from: &Flat, merged: &Flat, outcome: &gix::merge::tree::Outcome<'_>) -> Result<bool, Exit> {
    two_way(ctx, from, merged, "merge")?;
    let how = TreatAsUnresolved::git();
    if !outcome.has_unresolved_conflicts(how) {
        return Ok(false);
    }
    let mut index = load_index(ctx)?;
    outcome.index_changed_after_applying_conflicts(&mut index, how, RemovalMode::Prune);
    index.write(Default::default())?;
    Ok(true)
}

/// `git merge --abort` (`reset --merge`): every path the index changed goes back to HEAD; other local changes stay.
fn abort(ctx: &Ctx) -> Res {
    if !merging() {
        return fatal("There is no merge to abort (MERGE_HEAD missing).");
    }
    crate::worktree::reset_merge(ctx)?;
    clear_state();
    Ok(0)
}

pub fn merge(ctx: &Ctx, args: &[String]) -> Res {
    let (mut no_ff, mut ff_only, mut stat, mut quiet) = (false, false, true, false);
    let (mut msgs, mut revs) = (Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--no-ff" => no_ff = true,
            "--ff" => (no_ff, ff_only) = (false, false),
            "--ff-only" => ff_only = true,
            "--abort" => return abort(ctx),
            "--continue" => {
                if !merging() {
                    return fatal("There is no merge in progress (MERGE_HEAD missing).");
                }
                return crate::history::commit(ctx, &[]);
            }
            "-q" | "--quiet" => quiet = true,
            "--stat" => stat = true,
            "-n" | "--no-stat" => stat = false,
            "--no-edit" | "--edit" | "-e" | "--no-verify" | "-v" | "--verbose" => {}
            "-m" | "--message" => match it.next() {
                Some(m) => msgs.push(m.clone()),
                None => return Err(Exit { code: 129, msg: "error: switch `m' requires a value".into() }),
            },
            a if a.starts_with("--message=") => msgs.push(a[10..].to_string()),
            a if a.starts_with("-m") && a.len() > 2 => msgs.push(a[2..].to_string()),
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => revs.push(a.to_string()),
        }
    }
    if !unmerged(&*load_index(ctx)?).is_empty() {
        return Err(Exit { code: 128, msg: UNMERGED.into() });
    }
    if merging() {
        return fatal("You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.");
    }
    let spec = match revs.as_slice() {
        [one] => one.clone(),
        [] => {
            let branch = ctx.repo.head_name()?.map(|n| n.shorten().to_str_lossy().into_owned());
            match branch.and_then(|b| crate::status::upstream(ctx, &b)) {
                Some((short, _)) => short,
                None => return fatal("No remote for the current branch."),
            }
        }
        _ => return fatal("merging more than one commit (an octopus merge) is not supported in the playground"),
    };
    let Some(theirs) = ctx.repo.rev_parse_single(spec.as_str()).ok().and_then(|id| id.object().ok()?.peel_to_commit().ok()) else {
        eprintln!("merge: {spec} - not something we can merge");
        return Ok(1);
    };
    let Ok(head) = ctx.repo.head_commit() else {
        return fatal("merging into a branch without commits is not supported in the playground");
    };
    let say = |s: &str| if !quiet { out(s) };
    let base = ctx.repo.merge_base(head.id, theirs.id).ok().flatten().map(|b| b.detach());
    if base == Some(theirs.id) {
        say("Already up to date.\n");
        return Ok(0);
    }
    let (h, t) = (commit_flat(ctx, &head)?, commit_flat(ctx, &theirs)?);
    if base == Some(head.id) && !no_ff {
        say(&format!("Updating {}..{}\n", short(head.id), short(theirs.id)));
        two_way(ctx, &h, &t, "merge")?;
        write_state("ORIG_HEAD", &format!("{}\n", head.id))?;
        move_head(ctx, theirs.id, &format!("merge {spec}: Fast-forward"))?;
        say("Fast-forward\n");
        if stat {
            say(&crate::diff::stat(ctx, &h, &t, true)?);
        }
        return Ok(0);
    }
    if ff_only {
        eprintln!(
            "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config set advice.diverging false\""
        );
        return fatal("Not possible to fast-forward, aborting.");
    }
    if base.is_none() {
        return fatal("refusing to merge unrelated histories");
    }
    // merge-ort refuses to start with staged changes
    let idx = flat_index(&load_index(ctx)?);
    let staged: Vec<String> = h.keys().chain(idx.keys()).filter(|p| h.get(*p) != idx.get(*p)).map(path_str).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    if !staged.is_empty() {
        return Err(Exit { code: 2, msg: format!("error: Your local changes to the following files would be overwritten by merge:\n  {}\nMerge with strategy ort failed.", staged.join("\n  ")) });
    }
    let labels = gix::merge::blob::builtin_driver::text::Labels { ancestor: None, current: Some(BStr::new("HEAD")), other: Some(BStr::new(spec.as_str())) };
    let options = ctx.repo.tree_merge_options()?;
    let mut outcome = ctx.repo.merge_commits(head.id, theirs.id, labels, options.into())?;
    let tree = outcome.tree_merge.tree.write()?.detach();
    let merged = flat_tree(ctx, tree)?;
    let conflicted = apply_merged(ctx, &h, &merged, &outcome.tree_merge).map_err(|e| Exit { code: 2, msg: format!("{}\nMerge with strategy ort failed.", e.msg) })?;
    for line in conflict_messages(&outcome.tree_merge.conflicts, "HEAD", &spec) {
        say(&format!("{line}\n"));
    }
    let message = if msgs.is_empty() { default_message(ctx, &spec)? } else { msgs.join("\n\n") };
    write_state("ORIG_HEAD", &format!("{}\n", head.id))?;
    if conflicted {
        let paths: Vec<String> = unmerged(&*load_index(ctx)?).keys().map(|p| format!("#\t{}\n", path_str(p))).collect();
        write_state("MERGE_HEAD", &format!("{}\n", theirs.id))?;
        write_state("MERGE_MODE", if no_ff { "no-ff" } else { "" })?;
        write_state("MERGE_MSG", &format!("{message}\n\n# Conflicts:\n{}", paths.concat()))?;
        say("Automatic merge failed; fix conflicts and then commit the result.\n");
        return Ok(1);
    }
    let sig = crate::history::signature(ctx);
    let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
    let id = ctx.repo.new_commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), format!("{message}\n"), tree, [head.id, theirs.id])?.id;
    move_head(ctx, id, &format!("merge {spec}: Merge made by the 'ort' strategy."))?;
    say("Merge made by the 'ort' strategy.\n");
    if stat {
        say(&crate::diff::stat(ctx, &h, &merged, true)?);
    }
    Ok(0)
}
