// `git merge`: fast-forwards, and true merges with gix's merge machinery (gix-merge, merge-ort's results: the merged
// tree with conflict markers in the conflicting files, the index's conflict stages, MERGE_HEAD and MERGE_MSG).
use crate::history::short;
use crate::status::{Flat, flat_index, flat_tree, load_index, merging, unmerged, worktree_changes};
use crate::worktree::{commit_flat, move_head, two_way};
use crate::{Ctx, Exit, Res, fatal, out, path_str};
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use std::collections::{BTreeSet, HashSet};
use gix::merge::tree::{Conflict, Resolution, ResolutionFailure, TreatAsUnresolved, apply_index_entries::RemovalMode};

const STATE: [&str; 5] = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "SQUASH_MSG"];

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

/// A commit to merge, named as fmt-merge-msg names it: `branch 'feat'`, `tag 'v1'` (with an annotated tag's message),
/// `remote-tracking branch 'origin/main'`, `commit '<rev>'`; `pull`'s are `branch 'main' of <url>`.
pub struct Head<'r> {
    pub commit: gix::Commit<'r>,
    /// the conflict markers' label: the rev as typed (`pull`: the commit's id)
    pub label: String,
    /// `branch`, `remote-tracking branch`, `tag` or `commit`
    pub kind: &'static str,
    pub name: String,
    pub tag_message: Option<String>,
    /// where `pull` fetched it from
    pub source: Option<String>,
}

impl<'r> Head<'r> {
    /// The rev as typed, or `None` when it names no commit.
    pub fn resolve(ctx: &'r Ctx, name: &str) -> Option<Head<'r>> {
        let commit = ctx.repo.rev_parse_single(name).ok()?.object().ok()?.peel_to_commit().ok()?;
        let find = |full: String| ctx.repo.try_find_reference(full.as_str()).ok().flatten();
        let (kind, tag_message) = if find(format!("refs/heads/{name}")).is_some() {
            ("branch", None)
        } else if let Some(r) = find(format!("refs/tags/{name}")) {
            let message = match r.target().try_id().map(|id| ctx.repo.find_object(id)) {
                Some(Ok(o)) if o.kind == gix::object::Kind::Tag => o.try_into_tag().ok().and_then(|t| t.decode().ok().map(|t| t.message.to_str_lossy().trim().to_string())),
                _ => None,
            };
            ("tag", message.filter(|m| !m.is_empty()))
        } else if find(format!("refs/remotes/{name}")).is_some() {
            ("remote-tracking branch", None)
        } else {
            ("commit", None)
        };
        Some(Head { commit, label: name.to_string(), kind, name: name.to_string(), tag_message, source: None })
    }
}

/// fmt-merge-msg's title: `Merge branches 'a' and 'b', tag 'v1'`, grouped by where they came from (` of <url>`),
/// ` into <branch>` unless on main/master; then the annotated tags' messages.
fn default_message(ctx: &Ctx, heads: &[Head<'_>]) -> Result<String, Exit> {
    let mut groups: Vec<(Option<&str>, Vec<&Head<'_>>)> = Vec::new();
    for h in heads {
        match groups.iter_mut().find(|g| g.0 == h.source.as_deref()) {
            Some(g) => g.1.push(h),
            None => groups.push((h.source.as_deref(), vec![h])),
        }
    }
    let mut msg = "Merge ".to_string();
    for (i, (source, hs)) in groups.iter().enumerate() {
        if i > 0 {
            msg += "; ";
        }
        let mut parts = Vec::new();
        for (kind, plural) in [("branch", "branches"), ("remote-tracking branch", "remote-tracking branches"), ("tag", "tags"), ("commit", "commits")] {
            let names: Vec<String> = hs.iter().filter(|h| h.kind == kind).map(|h| format!("'{}'", h.name)).collect();
            match names.as_slice() {
                [] => {}
                [one] => parts.push(format!("{kind} {one}")),
                [init @ .., last] => parts.push(format!("{plural} {} and {last}", init.join(", "))),
            }
        }
        msg += &parts.join(", ");
        if let Some(s) = source {
            msg += &format!(" of {s}");
        }
    }
    match ctx.repo.head_name()? {
        Some(b) if !matches!(b.shorten().to_str_lossy().as_ref(), "main" | "master") => msg += &format!(" into {}", b.shorten()),
        None => msg += " into HEAD",
        _ => {}
    }
    for m in heads.iter().filter_map(|h| h.tag_message.as_ref()) {
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

/// What `merge` and `pull` were asked to do.
#[derive(Clone)]
pub struct Opts {
    pub no_ff: bool,
    pub ff_only: bool,
    pub squash: bool,
    /// false with `--no-commit`: stop before the merge commit, as after a conflict
    pub commit: bool,
    pub stat: bool,
    pub quiet: bool,
    pub msgs: Vec<String>,
    /// the reflog message's prefix: `merge feat`, `pull`
    pub reflog: String,
    /// `-s`: `ort` (also when none is given), `recursive` (ort by another name), `ours`, `octopus`
    pub strategy: Option<String>,
    /// `-X`: the strategy's options
    pub xopts: Vec<String>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { no_ff: false, ff_only: false, squash: false, commit: true, stat: true, quiet: false, msgs: Vec::new(), reflog: "merge".into(), strategy: None, xopts: Vec::new() }
    }
}

impl Opts {
    /// Take one of the options `merge` and `pull` share; false when `a` is none of them.
    pub fn take<'a>(&mut self, a: &str, it: &mut impl Iterator<Item = &'a String>) -> Result<bool, Exit> {
        match a {
            "--no-ff" => self.no_ff = true,
            "--ff" => (self.no_ff, self.ff_only) = (false, false),
            "--ff-only" => self.ff_only = true,
            "--squash" => self.squash = true,
            "--no-squash" => self.squash = false,
            "--commit" => self.commit = true,
            "--no-commit" => self.commit = false,
            "-q" | "--quiet" => self.quiet = true,
            "--stat" => self.stat = true,
            "-n" | "--no-stat" => self.stat = false,
            "--no-edit" | "--edit" | "-e" | "--no-verify" | "-v" | "--verbose" => {}
            "-m" | "--message" => match it.next() {
                Some(m) => self.msgs.push(m.clone()),
                None => return Err(Exit { code: 129, msg: "error: switch `m' requires a value".into() }),
            },
            "-s" | "--strategy" | "-X" | "--strategy-option" => match it.next() {
                Some(v) if matches!(a, "-s" | "--strategy") => self.strategy(v)?,
                Some(v) => self.xopts.push(v.clone()),
                None if a.starts_with("--") => return Err(Exit { code: 129, msg: format!("error: option `{}' requires a value", &a[2..]) }),
                None => return Err(Exit { code: 129, msg: format!("error: switch `{}' requires a value", &a[1..]) }),
            },
            a if a.starts_with("--strategy=") => self.strategy(&a[11..])?,
            a if a.starts_with("--strategy-option=") => self.xopts.push(a[18..].to_string()),
            a if a.starts_with("-s") && a.len() > 2 => self.strategy(&a[2..])?,
            a if a.starts_with("-X") && a.len() > 2 => self.xopts.push(a[2..].to_string()),
            a if a.starts_with("--message=") => self.msgs.push(a[10..].to_string()),
            a if a.starts_with("-m") && a.len() > 2 => self.msgs.push(a[2..].to_string()),
            _ => return Ok(false),
        }
        Ok(true)
    }
}

const STRATEGIES: [&str; 6] = ["octopus", "ours", "recursive", "resolve", "subtree", "ort"];

impl Opts {
    fn strategy(&mut self, name: &str) -> Result<(), Exit> {
        if !STRATEGIES.contains(&name) {
            return Err(Exit { code: 1, msg: format!("Could not find merge strategy '{name}'.\nAvailable strategies are: octopus ours recursive resolve subtree.") });
        }
        if matches!(name, "resolve" | "subtree") {
            return fatal(format!("merge strategy '{name}' is not supported in the playground (ort, recursive, ours and octopus are)"));
        }
        if self.strategy.as_deref().is_some_and(|s| s != name) {
            return fatal("only one merge strategy (-s) at a time is supported in the playground");
        }
        self.strategy = Some(name.to_string());
        Ok(())
    }

    /// The tree merge's options with `-X`'s: `ours`/`theirs` (the side a conflicting hunk takes), `no-renames`,
    /// `find-renames[=<n>]`/`rename-threshold=<n>`, `histogram`, `diff-algorithm=myers|minimal|histogram`.
    pub fn tree_options(&self, ctx: &Ctx) -> Result<gix::merge::tree::Options, Exit> {
        use gix::merge::blob::builtin_driver::{binary, text};
        let mut inner: gix::merge::plumbing::tree::Options = ctx.repo.tree_merge_options()?.into();
        for x in &self.xopts {
            let unknown = || Err(Exit { code: 128, msg: format!("fatal: unknown strategy option: -X{x}") });
            let unsupported = || fatal(format!("-X{x} is not supported in the playground"));
            match x.as_str() {
                "ours" | "theirs" => {
                    let (b, t) = if x == "ours" { (binary::ResolveWith::Ours, text::Conflict::ResolveWithOurs) } else { (binary::ResolveWith::Theirs, text::Conflict::ResolveWithTheirs) };
                    (inner.symlink_conflicts, inner.blob_merge.resolve_binary_with, inner.blob_merge.text.conflict) = (Some(b), Some(b), t);
                }
                "no-renames" => inner.rewrites = None,
                "find-renames" => inner.rewrites = Some(inner.rewrites.unwrap_or_default()),
                "histogram" => inner.blob_merge.text.diff_algorithm = gix::diff::blob::Algorithm::Histogram,
                "no-renormalize" => {}
                x if x.starts_with("diff-algorithm=") => {
                    inner.blob_merge.text.diff_algorithm = match &x[15..] {
                        "myers" | "default" => gix::diff::blob::Algorithm::Myers,
                        "minimal" => gix::diff::blob::Algorithm::MyersMinimal,
                        "histogram" => gix::diff::blob::Algorithm::Histogram,
                        "patience" => return unsupported(),
                        _ => return unknown(),
                    }
                }
                x if x.starts_with("find-renames=") || x.starts_with("rename-threshold=") => {
                    let Some(score) = rename_score(&x[x.find('=').unwrap_or(0) + 1..]) else { return unknown() };
                    inner.rewrites = Some(gix::diff::Rewrites { percentage: Some(score), ..inner.rewrites.unwrap_or_default() });
                }
                "patience" | "ignore-space-change" | "ignore-all-space" | "ignore-space-at-eol" | "ignore-cr-at-eol" | "renormalize" | "subtree" => return unsupported(),
                x if x.starts_with("subtree=") => return unsupported(),
                _ => return unknown(),
            }
        }
        Ok(inner.into())
    }
}

/// git's parse_rename_score: `50%` is a half, as are `5` and `50` (digits after an implied `0.`).
fn rename_score(s: &str) -> Option<f32> {
    if let Some(p) = s.strip_suffix('%') {
        return p.parse::<f32>().ok().filter(|_| p.bytes().all(|b| b.is_ascii_digit() || b == b'.')).map(|v| (v / 100.0).min(1.0));
    }
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    format!("0.{s}").parse().ok()
}

pub fn merge(ctx: &Ctx, args: &[String]) -> Res {
    let mut o = Opts::default();
    let mut revs = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--abort" => return abort(ctx),
            "--continue" => {
                if !merging() {
                    return fatal("There is no merge in progress (MERGE_HEAD missing).");
                }
                return crate::history::commit(ctx, &[]);
            }
            a if o.take(a, &mut it)? => {}
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => revs.push(a.to_string()),
        }
    }
    if o.squash && o.no_ff {
        return fatal("options '--squash' and '--no-ff.' cannot be used together");
    }
    if !unmerged(&*load_index(ctx)?).is_empty() {
        return Err(Exit { code: 128, msg: UNMERGED.into() });
    }
    if merging() {
        return fatal("You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.");
    }
    if revs.is_empty() {
        let branch = ctx.repo.head_name()?.map(|n| n.shorten().to_str_lossy().into_owned());
        match branch.and_then(|b| crate::status::upstream(ctx, &b)) {
            Some((short, _)) => revs.push(short),
            None => return fatal("No remote for the current branch."),
        }
    }
    o.reflog = format!("merge {}", revs.join(" "));
    let mut heads = Vec::new();
    for r in &revs {
        match Head::resolve(ctx, r) {
            Some(h) => heads.push(h),
            None => {
                eprintln!("merge: {r} - not something we can merge");
                return Ok(1);
            }
        }
    }
    run(ctx, &o, heads)
}

fn is_ancestor(ctx: &Ctx, a: ObjectId, b: ObjectId) -> bool {
    a == b || ctx.repo.merge_base(a, b).ok().flatten().is_some_and(|m| m.detach() == a)
}

const DIVERGING: &str = "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config set advice.diverging false\"\nfatal: Not possible to fast-forward, aborting.";

/// Merge `heads` into HEAD: a fast-forward, a true merge (gix's merge-ort) or, with more than one, an octopus.
pub fn run(ctx: &Ctx, o: &Opts, heads: Vec<Head<'_>>) -> Res {
    let say = |s: &str| if !o.quiet { out(s) };
    let Ok(head) = ctx.repo.head_commit() else { return into_unborn(ctx, o, &heads) };
    // reduce_heads: drop what HEAD or another of them already contains
    let ids: Vec<ObjectId> = heads.iter().map(|h| h.commit.id).collect();
    let keep: Vec<bool> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| !is_ancestor(ctx, *id, head.id) && !ids.iter().enumerate().any(|(j, other)| j != i && if other == id { j < i } else { is_ancestor(ctx, *id, *other) }))
        .collect();
    let remotes: Vec<Head<'_>> = heads.into_iter().zip(keep).filter(|(_, k)| *k).map(|(h, _)| h).collect();
    if remotes.is_empty() {
        say(if o.squash { "Already up to date. (nothing to squash)\n" } else { "Already up to date.\n" });
        return Ok(0);
    }
    let subsumed = remotes.iter().any(|r| is_ancestor(ctx, head.id, r.commit.id));
    let message = if o.msgs.is_empty() { default_message(ctx, &remotes)? } else { o.msgs.join("\n\n") };
    let h = commit_flat(ctx, &head)?;
    let strategy = o.strategy.as_deref().unwrap_or(if remotes.len() > 1 { "octopus" } else { "ort" });
    // `ours` never fast-forwards: the merge commit is the point
    let ours = strategy == "ours";
    if remotes.len() == 1 && subsumed && !o.no_ff && !ours {
        let theirs = &remotes[0].commit;
        let t = commit_flat(ctx, theirs)?;
        say(&format!("Updating {}..{}\n", short(head.id), short(theirs.id)));
        two_way(ctx, &h, &t, "merge")?;
        write_state("ORIG_HEAD", &format!("{}\n", head.id))?;
        say("Fast-forward\n");
        if o.squash {
            write_state("SQUASH_MSG", &squash_message(ctx, head.id, &remotes)?)?;
            out("Squash commit -- not updating HEAD\n");
        } else {
            move_head(ctx, theirs.id, &format!("{}: Fast-forward", o.reflog))?;
        }
        if o.stat {
            say(&crate::diff::stat(ctx, &h, &t, true)?);
        }
        return Ok(0);
    }
    if o.ff_only && !ours {
        return Err(Exit { code: 128, msg: DIVERGING.into() });
    }
    if ours {
        // the merge commit keeps HEAD's tree; only staged changes stop it
        if !staged_paths(ctx, &h)?.is_empty() {
            return Err(Exit { code: 2, msg: "Merge with strategy ours failed.".into() });
        }
        let o = Opts { no_ff: true, ..o.clone() };
        return finish(ctx, &o, &head, &remotes, head.tree_id()?.detach(), (&h, &h), false, false, "ours", &message);
    }
    if remotes.len() > 1 {
        if strategy != "octopus" {
            return fatal(format!("merge strategy '{strategy}' merges one branch at a time: merge several with the default (octopus) strategy"));
        }
        return octopus(ctx, o, &head, &h, &remotes, subsumed, &message);
    }
    if strategy == "octopus" {
        return fatal("merge strategy 'octopus' needs two or more branches to merge: merge one with the default (ort) strategy");
    }
    let (theirs, spec) = (&remotes[0].commit, remotes[0].label.as_str());
    if ctx.repo.merge_base(head.id, theirs.id).ok().flatten().is_none() {
        return fatal("refusing to merge unrelated histories");
    }
    // merge-ort refuses to start with staged changes
    let staged = staged_paths(ctx, &h)?;
    if !staged.is_empty() {
        return Err(Exit { code: 2, msg: format!("error: Your local changes to the following files would be overwritten by merge:\n  {}\nMerge with strategy ort failed.", staged.join("\n  ")) });
    }
    let labels = gix::merge::blob::builtin_driver::text::Labels { ancestor: None, current: Some(BStr::new("HEAD")), other: Some(BStr::new(spec)) };
    let options = o.tree_options(ctx)?;
    let mut outcome = ctx.repo.merge_commits(head.id, theirs.id, labels, options.into())?;
    let tree = outcome.tree_merge.tree.write()?.detach();
    let merged = flat_tree(ctx, tree)?;
    let conflicted = apply_merged(ctx, &h, &merged, &outcome.tree_merge).map_err(|e| Exit { code: 2, msg: format!("{}\nMerge with strategy ort failed.", e.msg) })?;
    for line in conflict_messages(&outcome.tree_merge.conflicts, "HEAD", spec) {
        say(&format!("{line}\n"));
    }
    finish(ctx, o, &head, &remotes, tree, (&h, &merged), conflicted, subsumed, strategy, &message)
}

/// The paths whose index entry differs from `h`.
fn staged_paths(ctx: &Ctx, h: &Flat) -> Result<Vec<String>, Exit> {
    let idx = flat_index(&load_index(ctx)?);
    Ok(h.keys().chain(idx.keys()).filter(|p| h.get(*p) != idx.get(*p)).map(path_str).collect::<std::collections::BTreeSet<_>>().into_iter().collect())
}

/// After the merged tree is in the index and the worktree: the merge commit, or the state a commit concludes
/// (MERGE_HEAD, MERGE_MSG, MERGE_MODE; SQUASH_MSG for `--squash`).
#[allow(clippy::too_many_arguments)]
fn finish(ctx: &Ctx, o: &Opts, head: &gix::Commit<'_>, remotes: &[Head<'_>], tree: ObjectId, (h, merged): (&Flat, &Flat), conflicted: bool, subsumed: bool, strategy: &str, message: &str) -> Res {
    let say = |s: &str| if !o.quiet { out(s) };
    write_state("ORIG_HEAD", &format!("{}\n", head.id))?;
    let ids: String = remotes.iter().map(|r| format!("{}\n", r.commit.id)).collect();
    let mode = if o.no_ff { "no-ff" } else { "" };
    if conflicted {
        let paths: String = unmerged(&*load_index(ctx)?).keys().map(|p| format!("#\t{}\n", path_str(p))).collect();
        let title = if o.squash { String::new() } else { format!("{message}\n") };
        write_state("MERGE_MSG", &format!("{title}\n# Conflicts:\n{paths}"))?;
        if o.squash {
            write_state("SQUASH_MSG", &squash_message(ctx, head.id, remotes)?)?;
            out("Squash commit -- not updating HEAD\n");
        } else {
            write_state("MERGE_HEAD", &ids)?;
            write_state("MERGE_MODE", mode)?;
        }
        out("Automatic merge failed; fix conflicts and then commit the result.\n");
        return Ok(1);
    }
    if o.squash || !o.commit {
        eprintln!("Automatic merge went well; stopped before committing as requested");
        if o.squash {
            write_state("SQUASH_MSG", &squash_message(ctx, head.id, remotes)?)?;
            out("Squash commit -- not updating HEAD\n");
        } else {
            write_state("MERGE_HEAD", &ids)?;
            write_state("MERGE_MSG", &format!("{message}\n"))?;
            write_state("MERGE_MODE", mode)?;
        }
        return Ok(0);
    }
    let parents: Vec<ObjectId> = (!subsumed || o.no_ff).then_some(head.id).into_iter().chain(remotes.iter().map(|r| r.commit.id)).collect();
    let sig = crate::history::signature(ctx);
    let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
    let id = ctx.repo.new_commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), format!("{message}\n"), tree, parents)?.id;
    move_head(ctx, id, &format!("{}: Merge made by the '{strategy}' strategy.", o.reflog))?;
    say(&format!("Merge made by the '{strategy}' strategy.\n"));
    if o.stat && strategy != "ours" {
        say(&crate::diff::stat(ctx, h, merged, true)?);
    }
    Ok(0)
}

/// SQUASH_MSG: the commits being squashed, newest first, in `git log`'s medium format.
fn squash_message(ctx: &Ctx, head: ObjectId, remotes: &[Head<'_>]) -> Result<String, Exit> {
    let mut s = String::from("Squashed commit of the following:\n");
    let order = gix::revision::walk::Sorting::ByCommitTime(gix::traverse::commit::simple::CommitTimeOrder::NewestFirst);
    for info in ctx.repo.rev_walk(remotes.iter().map(|r| r.commit.id)).sorting(order).with_hidden([head]).all()? {
        let c = ctx.repo.find_commit(info?.id)?;
        s += &format!("\ncommit {}\n", c.id);
        let parents: Vec<String> = c.parent_ids().map(|p| short(p.detach())).collect();
        if parents.len() > 1 {
            s += &format!("Merge: {}\n", parents.join(" "));
        }
        let author = c.author()?;
        s += &format!("Author: {} <{}>\n", author.name.to_str_lossy(), author.email.to_str_lossy());
        s += &format!("Date:   {}\n\n", author.time()?.format_or_unix(gix::date::time::format::DEFAULT));
        for l in c.message_raw_sloppy().to_str_lossy().trim_end_matches('\n').lines() {
            s += &format!("    {l}\n");
        }
    }
    Ok(s)
}

/// Merging into a branch without commits: its first commit becomes the merged one (read-tree from the empty tree).
fn into_unborn(ctx: &Ctx, o: &Opts, heads: &[Head<'_>]) -> Res {
    let [theirs] = heads else { return fatal("Can merge only exactly one commit into empty head") };
    if o.squash {
        return fatal("Squash commit into empty head not supported yet");
    }
    if o.no_ff {
        return fatal("Non-fast-forward commit does not make sense into an empty head");
    }
    let t = commit_flat(ctx, &theirs.commit)?;
    let idx = flat_index(&load_index(ctx)?);
    let blocked: String = t
        .keys()
        .filter(|p| !idx.contains_key(*p) && std::fs::symlink_metadata(crate::worktree::disk(p.as_ref())).is_ok())
        .map(|p| format!("error: Untracked working tree file '{}' would be overwritten by merge.\n", path_str(p)))
        .collect();
    if !blocked.is_empty() {
        return Err(Exit { code: 128, msg: format!("{blocked}fatal: read-tree failed") });
    }
    two_way(ctx, &Flat::new(), &t, "merge")?;
    move_head(ctx, theirs.commit.id, "initial pull")?;
    Ok(0)
}

const OCTOPUS_FAILED: &str = "Merge with strategy octopus failed.";

/// git-merge-octopus: the heads one after the other onto the tree so far (fast-forwarding while it can), each a
/// three-way merge with the merge base of it and everything merged so far. Only the last may leave conflicts.
fn octopus(ctx: &Ctx, o: &Opts, head: &gix::Commit<'_>, h: &Flat, remotes: &[Head<'_>], subsumed: bool, message: &str) -> Res {
    let staged = staged_paths(ctx, h)?;
    if !staged.is_empty() {
        out("Error: Your local changes to the following files would be overwritten by merge\n");
        for p in staged {
            out(&format!("    {p}\n"));
        }
        return Err(Exit { code: 2, msg: OCTOPUS_FAILED.into() });
    }
    let dirty: HashSet<BString> = worktree_changes(ctx, gix::status::UntrackedFiles::None)?.into_iter().map(|w| w.path).collect();
    // read-tree -u -m refuses to touch a changed file or overwrite an untracked one
    let check = |from: &Flat, to: &Flat| -> Result<(), Exit> {
        let paths: BTreeSet<&BString> = from.keys().chain(to.keys()).filter(|p| from.get(*p) != to.get(*p)).collect();
        for p in paths {
            if dirty.contains(p) {
                return Err(Exit { code: 2, msg: format!("error: Entry '{}' not uptodate. Cannot merge.\n{OCTOPUS_FAILED}", path_str(p)) });
            }
            if !h.contains_key(p) && to.contains_key(p) && std::fs::symlink_metadata(crate::worktree::disk(p.as_ref())).is_ok() {
                return Err(Exit { code: 2, msg: format!("error: Untracked working tree file '{}' would be overwritten by merge.\n{OCTOPUS_FAILED}", path_str(p)) });
            }
        }
        Ok(())
    };
    // git-merge-octopus takes no strategy options
    let options = ctx.repo.tree_merge_options()?;
    let how = TreatAsUnresolved::git();
    let (mut mrc, mut mrt, mut mrt_id) = (vec![head.id], h.clone(), head.tree_id()?.detach());
    let mut non_ff = false;
    let mut last: Option<gix::merge::tree::Outcome<'_>> = None;
    for r in remotes {
        if last.as_ref().is_some_and(|l| l.has_unresolved_conflicts(how)) {
            out("Automated merge did not work.\nShould not be doing an octopus.\n");
            return Err(Exit { code: 2, msg: OCTOPUS_FAILED.into() });
        }
        let bases = ctx.repo.merge_bases_many(r.commit.id, &mrc)?;
        let [common] = bases.as_slice() else {
            return Err(Exit { code: 2, msg: format!("Unable to find common commit with {}\n{OCTOPUS_FAILED}", r.label) });
        };
        let common = common.detach();
        if common == r.commit.id {
            out(&format!("Already up to date with {}\n", r.label));
            continue;
        }
        let their_tree = r.commit.tree_id()?.detach();
        if mrc == [common] && !non_ff {
            out(&format!("Fast-forwarding to: {}\n", r.label));
            let t = flat_tree(ctx, their_tree)?;
            check(&mrt, &t)?;
            (mrc, mrt, mrt_id, last) = (vec![r.commit.id], t, their_tree, None);
            continue;
        }
        non_ff = true;
        out(&format!("Trying simple merge with {}\n", r.label));
        let labels = gix::merge::blob::builtin_driver::text::Labels { ancestor: None, current: Some(BStr::new("HEAD")), other: Some(BStr::new(r.label.as_str())) };
        let base_tree = ctx.repo.find_commit(common)?.tree_id()?.detach();
        let mut outcome = ctx.repo.merge_trees(base_tree, mrt_id, their_tree, labels, options.clone())?;
        let next_id = outcome.tree.write()?.detach();
        let next = flat_tree(ctx, next_id)?;
        check(&mrt, &next)?;
        if !outcome.conflicts.is_empty() {
            // merge-index with git-merge-one-file: the paths both sides changed, one by one
            out("Simple merge did not work, trying automatic merge.\n");
            let mut lines: Vec<(String, bool)> = outcome
                .conflicts
                .iter()
                .filter(|c| matches!(c.resolution, Ok(Resolution::OursModifiedTheirsModifiedThenBlobContentMerge { .. })) || c.is_unresolved(how))
                .map(|c| (path_str(&c.ours.location().to_owned()), c.is_unresolved(how)))
                .collect();
            lines.sort();
            for (p, bad) in &lines {
                out(&format!("Auto-merging {p}\n"));
                if *bad {
                    eprintln!("ERROR: content conflict in {p}");
                }
            }
            if lines.iter().any(|l| l.1) {
                eprintln!("fatal: merge program failed");
            }
        }
        mrc.push(r.commit.id);
        (mrt, mrt_id, last) = (next, next_id, Some(outcome));
    }
    let conflicted = match &last {
        Some(l) => apply_merged(ctx, h, &mrt, l),
        None => two_way(ctx, h, &mrt, "merge").map(|_| false),
    }
    .map_err(|e| Exit { code: 2, msg: format!("{}\n{OCTOPUS_FAILED}", e.msg) })?;
    finish(ctx, o, head, remotes, mrt_id, (h, &mrt), conflicted, subsumed, "octopus", message)
}
