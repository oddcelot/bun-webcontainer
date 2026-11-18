// `git rebase` without -i (the merge backend's linear case) and `pull --rebase`: the commits of upstream..HEAD replayed
// onto upstream one at a time, each picked as a tree merge (its parent as the base) with gix's merge machinery. The
// state is the sequencer's (.git/rebase-merge/: head-name, onto, orig-head, git-rebase-todo, done, msgnum, end), so a
// stop on a conflict reads as git's to `status`, and `--continue`, `--skip`, `--abort` and `--quit` pick it up.
use crate::history::{short, signature};
use crate::merge::{apply_merged, conflict_messages};
use crate::status::{Flat, flat_head, flat_index, flat_tree, load_index, unmerged, worktree_changes};
use crate::worktree::{commit_flat, hard_reset, set_head_branch, two_way};
use crate::{Ctx, Exit, Res, fatal, out, path_str};
use gix::ObjectId;
use gix::bstr::{BStr, ByteSlice};
use gix::refs::transaction::PreviousValue;
use std::collections::HashSet;

const DIR: &str = "/.git/rebase-merge";

fn path(name: &str) -> String {
    format!("{DIR}/{name}")
}

fn read(name: &str) -> Option<String> {
    std::fs::read_to_string(path(name)).ok()
}

fn write(name: &str, text: &str) -> Result<(), Exit> {
    std::fs::write(path(name), text)?;
    Ok(())
}

/// A rebase is in progress (the merge backend's state directory).
pub fn in_progress() -> bool {
    std::path::Path::new(DIR).is_dir()
}

/// The files a stop on a conflict leaves; `--continue` and `--skip` remove them.
fn clear_stop() {
    for f in ["message", "author-script", "stopped-sha", "patch"] {
        let _ = std::fs::remove_file(path(f));
    }
    // REBASE_HEAD stays (until the next stop, or --abort), as git's
    for f in ["MERGE_MSG", "AUTO_MERGE"] {
        let _ = std::fs::remove_file(format!("/.git/{f}"));
    }
}

fn subject(c: &gix::Commit<'_>) -> String {
    c.message_raw_sloppy().to_str_lossy().lines().next().unwrap_or("").to_string()
}

/// `pick <id> # <subject>`, and ` # empty` for a commit that changes nothing.
fn todo_line(ctx: &Ctx, id: ObjectId) -> Result<String, Exit> {
    let c = ctx.repo.find_commit(id)?;
    let parent_tree = match c.parent_ids().next() {
        Some(p) => ctx.repo.find_commit(p)?.tree_id()?.detach(),
        None => ctx.repo.empty_tree().id,
    };
    let empty = if c.tree_id()?.detach() == parent_tree { " # empty" } else { "" };
    Ok(format!("pick {id} # {}{empty}\n", subject(&c)))
}

/// The commits in a todo list (`pick <id> [# subject]` lines; comments and blank lines skipped).
fn parse_todo(ctx: &Ctx, text: &str) -> Result<Vec<ObjectId>, Exit> {
    let mut ids = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut words = line.split_whitespace();
        let (cmd, rev) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
        if !matches!(cmd, "pick" | "p") {
            return fatal(format!("'{cmd}' in the rebase's todo list is not supported in the playground (only pick is)"));
        }
        ids.push(ctx.repo.rev_parse_single(rev).map_err(|_| Exit { code: 128, msg: format!("fatal: invalid line in the rebase's todo list: {line}") })?.detach());
    }
    Ok(ids)
}

/// The strategy options (`-X`), as the sequencer keeps them in `strategy_opts` (` '--theirs'`).
fn tree_options(ctx: &Ctx, xopts: &[String]) -> Result<gix::merge::tree::Options, Exit> {
    crate::merge::Opts { xopts: xopts.to_vec(), ..Default::default() }.tree_options(ctx)
}

fn saved_xopts() -> Vec<String> {
    read("strategy_opts").unwrap_or_default().split_whitespace().map(|w| w.trim_matches('\'').trim_start_matches("--").to_string()).collect()
}

/// require_clean_work_tree: staged or unstaged changes to tracked files stop a rebase (untracked files don't).
pub fn require_clean(ctx: &Ctx, action: &str) -> Result<(), Exit> {
    let index = load_index(ctx)?;
    let (h, idx) = (flat_head(ctx)?, flat_index(&index));
    let staged = h != idx || !unmerged(&index).is_empty();
    let unstaged = worktree_changes(ctx, gix::status::UntrackedFiles::None)?.iter().any(|w| !matches!(w.kind, crate::status::Kind::Untracked));
    let msg = match (unstaged, staged) {
        (false, false) => return Ok(()),
        (true, false) => format!("error: cannot {action}: You have unstaged changes."),
        (true, true) => format!("error: cannot {action}: You have unstaged changes.\nerror: additionally, your index contains uncommitted changes."),
        (false, true) => format!("error: cannot {action}: Your index contains uncommitted changes."),
    };
    Err(Exit { code: 1, msg: format!("{msg}\nerror: Please commit or stash them.") })
}

const IN_PROGRESS: &str = "It seems that there is already a rebase-merge directory, and
I wonder if you are in the middle of another rebase.  If that is the
case, please try
\tgit rebase (--continue | --abort | --skip)
If that is not the case, please
\trm -fr \".git/rebase-merge\"
and run me again.  I am stopping in case you still have something
valuable there.
";

const NO_UPSTREAM: &str = "There is no tracking information for the current branch.
Please specify which branch you want to rebase against.
See git-rebase(1) for details.

    git rebase '<branch>'

If you wish to set tracking information for this branch you can do so with:

    git branch --set-upstream-to=<remote>/<branch> {branch}

";

pub fn rebase(ctx: &Ctx, args: &[String]) -> Res {
    let (mut quiet, mut onto, mut xopts, mut pos, mut action) = (false, None, Vec::new(), Vec::new(), None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--continue" | "--abort" | "--skip" | "--quit" => action = Some(a.clone()),
            "-q" | "--quiet" => quiet = true,
            "-v" | "--verbose" | "--stat" | "-n" | "--no-stat" | "-m" | "--merge" | "--no-autostash" | "--no-update-refs" | "--no-autosquash" => {}
            "--onto" => onto = Some(it.next().cloned().ok_or(Exit { code: 129, msg: "error: option `onto' requires a value".into() })?),
            a if a.starts_with("--onto=") => onto = Some(a[7..].to_string()),
            "-X" | "--strategy-option" => xopts.push(it.next().cloned().ok_or(Exit { code: 129, msg: "error: option `strategy-option' requires a value".into() })?),
            a if a.starts_with("--strategy-option=") => xopts.push(a[18..].to_string()),
            a if a.starts_with("-X") => xopts.push(a[2..].to_string()),
            "-s" | "--strategy" => match it.next().map(String::as_str) {
                Some("ort" | "recursive") => {}
                Some(s) => return fatal(format!("rebase strategy '{s}' is not supported in the playground (ort is)")),
                None => return Err(Exit { code: 129, msg: "error: option `strategy' requires a value".into() }),
            },
            "-i" | "--interactive" | "-x" | "--exec" | "-r" | "--rebase-merges" | "--root" | "--autosquash" | "--edit-todo" | "--apply" | "--autostash" | "--update-refs" | "--keep-base" | "--signoff" | "--reapply-cherry-picks" | "-f" | "--force-rebase" | "--no-ff" => {
                return fatal(format!("git rebase {a} is not supported in the playground (git rebase [--onto <newbase>] [<upstream> [<branch>]], --continue, --skip, --abort, --quit are)"));
            }
            a if a.starts_with("--rebase-merges=") || a.starts_with("--exec=") || a.starts_with("--strategy=") => {
                return fatal(format!("git rebase {a} is not supported in the playground"));
            }
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => pos.push(a.to_string()),
        }
    }
    if let Some(action) = action {
        if !in_progress() {
            return fatal("no rebase in progress");
        }
        return match action.as_str() {
            "--continue" => continue_rebase(ctx),
            "--skip" => skip(ctx),
            "--abort" => abort(ctx),
            _ => {
                std::fs::remove_dir_all(DIR)?;
                Ok(0)
            }
        };
    }
    if in_progress() {
        return fatal(IN_PROGRESS);
    }
    if pos.len() > 2 {
        return Err(Exit { code: 129, msg: "usage: git rebase [-i] [options] [--exec <cmd>] [--onto <newbase> | --keep-base] [<upstream> [<branch>]]".into() });
    }
    let upstream_name = match pos.first() {
        Some(u) if u == "-" => "@{-1}".to_string(),
        Some(u) => u.clone(),
        None => {
            let branch = ctx.repo.head_name()?.map(|n| n.shorten().to_str_lossy().into_owned());
            match branch.as_ref().and_then(|b| crate::status::upstream(ctx, b)) {
                Some((short, _)) => short,
                None => {
                    out(&NO_UPSTREAM.replace("{branch}", branch.as_deref().unwrap_or("<branch>")));
                    return Ok(1);
                }
            }
        }
    };
    let commit_of = |rev: &str| ctx.repo.rev_parse_single(rev).ok().and_then(|id| id.object().ok()?.peel_to_commit().ok()).map(|c| c.id);
    let Some(upstream) = commit_of(&upstream_name) else { return fatal(format!("invalid upstream '{upstream_name}'")) };
    // `rebase <upstream> <branch>`: that branch (or commit) is what gets rebased; git switches to it first
    let (head, head_name, branch_name, switch_to) = match pos.get(1) {
        Some(b) => match ctx.repo.try_find_reference(format!("refs/heads/{b}").as_str()).ok().flatten().and_then(|mut r| r.peel_to_id().ok().map(|id| id.detach())) {
            Some(id) => (id, Some(format!("refs/heads/{b}")), b.clone(), Some(b.clone())),
            None => match commit_of(b) {
                Some(id) => (id, None, b.clone(), Some(b.clone())),
                None => return fatal(format!("no such branch/commit '{b}'")),
            },
        },
        None => {
            let Ok(head) = ctx.repo.head_commit() else { return fatal("Could not resolve HEAD to a commit") };
            let head_name = ctx.repo.head_name()?.map(|n| n.as_bstr().to_str_lossy().into_owned());
            let branch_name = head_name.as_deref().map_or("HEAD".to_string(), |n| n.trim_start_matches("refs/heads/").to_string());
            (head.id, head_name, branch_name, None)
        }
    };
    let onto_name = onto.clone().unwrap_or_else(|| upstream_name.clone());
    let onto_id = match &onto {
        Some(o) => commit_of(o).ok_or_else(|| Exit { code: 128, msg: format!("fatal: Does not point to a valid commit '{o}'") })?,
        None => upstream,
    };
    start(ctx, head, upstream, onto_id, &Start { quiet, xopts, onto_name, head_name, branch_name, switch_to })
}

/// How a rebase was asked for.
pub struct Start {
    pub quiet: bool,
    pub xopts: Vec<String>,
    /// onto as typed, for the reflog
    pub onto_name: String,
    /// the branch being rebased (`refs/heads/<name>`), or None for a detached HEAD
    pub head_name: Option<String>,
    /// the branch (or commit, or `HEAD`) as `Current branch <name> is up to date` names it
    pub branch_name: String,
    /// `rebase <upstream> <branch>`'s branch, switched to when there is nothing to replay
    pub switch_to: Option<String>,
}

impl Start {
    /// A rebase of HEAD (the branch it is on, or a detached HEAD).
    pub fn of_head(ctx: &Ctx, quiet: bool, xopts: Vec<String>, onto_name: String) -> Result<Self, Exit> {
        let head_name = ctx.repo.head_name()?.map(|n| n.as_bstr().to_str_lossy().into_owned());
        let branch_name = head_name.as_deref().map_or("HEAD".to_string(), |n| n.trim_start_matches("refs/heads/").to_string());
        Ok(Start { quiet, xopts, onto_name, head_name, branch_name, switch_to: None })
    }
}

/// Rebase `head`'s commits since `upstream` onto `onto`.
pub fn start(ctx: &Ctx, head: ObjectId, upstream: ObjectId, onto: ObjectId, o: &Start) -> Res {
    require_clean(ctx, "rebase")?;
    let head_name = o.head_name.clone();
    // can_fast_forward: onto already in head's history (linearly), and nothing of upstream's left out
    let base = ctx.repo.merge_base(onto, head).ok().flatten().map(|b| b.detach());
    if base == Some(onto) && ctx.repo.merge_base(upstream, head).ok().flatten().map(|b| b.detach()) == Some(onto) && linear(ctx, onto, head)? {
        if let Some(to) = &o.switch_to {
            // checkout_up_to_date
            let target = commit_flat(ctx, &ctx.repo.find_commit(head)?)?;
            if let Err(e) = two_way(ctx, &flat_head(ctx)?, &target, "checkout") {
                eprintln!("{}\nerror: could not switch to {to}", e.msg);
                return Ok(1);
            }
            let msg = format!("rebase: checkout {to}");
            match head_name.as_deref().and_then(|n| n.strip_prefix("refs/heads/")) {
                Some(b) => set_head_branch(ctx, b, &msg)?,
                None => detach(ctx, head, &msg)?,
            }
        }
        if !o.quiet {
            if o.branch_name == "HEAD" {
                out("HEAD is up to date.\n");
            } else {
                out(&format!("Current branch {} is up to date.\n", o.branch_name));
            }
        }
        return Ok(0);
    }
    // upstream..HEAD without merges, oldest first; what upstream already has (the same patch) is left out
    let mut picks: Vec<ObjectId> = Vec::new();
    for info in ctx.repo.rev_walk([head]).with_hidden([upstream]).all()? {
        let info = info?;
        if info.parent_ids.len() <= 1 {
            picks.push(info.id);
        }
    }
    picks.reverse();
    if !picks.is_empty() {
        let theirs: Vec<ObjectId> = ctx.repo.rev_walk([upstream]).with_hidden([head]).all()?.filter_map(Result::ok).filter(|i| i.parent_ids.len() <= 1).map(|i| i.id).collect();
        if !theirs.is_empty() {
            let applied: HashSet<String> = theirs.iter().filter_map(|id| patch_id(ctx, *id).transpose()).collect::<Result<_, _>>()?;
            let mut skipped = false;
            let mut kept = Vec::new();
            for id in picks {
                if patch_id(ctx, id)?.is_some_and(|p| applied.contains(&p)) {
                    eprintln!("warning: skipped previously applied commit {}", short(id));
                    skipped = true;
                } else {
                    kept.push(id);
                }
            }
            if skipped && ctx.repo.config_snapshot().boolean("advice.skippedCherryPicks").unwrap_or(true) {
                eprintln!("hint: use --reapply-cherry-picks to include skipped commits\nhint: Disable this message with \"git config set advice.skippedCherryPicks false\"");
            }
            picks = kept;
        }
    }
    // checkout onto, detached
    let h = flat_head(ctx)?;
    let onto_commit = ctx.repo.find_commit(onto)?;
    if let Err(e) = two_way(ctx, &h, &commit_flat(ctx, &onto_commit)?, "checkout") {
        eprintln!("{}\nerror: could not detach HEAD", e.msg);
        return Ok(1);
    }
    std::fs::create_dir_all(DIR)?;
    write("head-name", &format!("{}\n", head_name.as_deref().unwrap_or("detached HEAD")))?;
    write("onto", &format!("{onto}\n"))?;
    write("orig-head", &format!("{head}\n"))?;
    for empty in ["interactive", "drop_redundant_commits", "no-reschedule-failed-exec"] {
        write(empty, "")?;
    }
    if o.quiet {
        write("quiet", "")?;
    }
    if !o.xopts.is_empty() {
        write("strategy", "ort\n")?;
        write("strategy_opts", &o.xopts.iter().map(|x| format!(" '--{x}'")).collect::<String>())?;
    }
    let todo: String = picks.iter().map(|id| todo_line(ctx, *id)).collect::<Result<_, _>>()?;
    write("git-rebase-todo", &todo)?;
    write("git-rebase-todo.backup", &todo)?;
    write("done", "")?;
    write("msgnum", "0\n")?;
    write("end", &format!("{}\n", picks.len()))?;
    crate::merge::write_state("ORIG_HEAD", &format!("{head}\n"))?;
    detach(ctx, onto, &format!("rebase (start): checkout {}", o.onto_name))?;
    run_todo(ctx)
}

/// is_linear_history: no merge between `from` (an ancestor) and `to`, following first parents.
fn linear(ctx: &Ctx, from: ObjectId, mut to: ObjectId) -> Result<bool, Exit> {
    while to != from {
        let c = ctx.repo.find_commit(to)?;
        let parents: Vec<ObjectId> = c.parent_ids().map(|p| p.detach()).collect();
        match parents.as_slice() {
            [] => return Ok(true),
            [p] => to = *p,
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn detach(ctx: &Ctx, id: ObjectId, msg: &str) -> Result<(), Exit> {
    use gix::refs::transaction::{Change, LogChange, RefEdit, RefLog};
    let repo = crate::history::with_committer(ctx)?;
    repo.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: msg.into() },
            expected: PreviousValue::Any,
            new: gix::refs::Target::Object(id),
        },
        name: "HEAD".try_into()?,
        deref: false,
    })?;
    Ok(())
}

/// A commit's patch, as git's patch-id sees it: the diff without the index lines, line numbers and whitespace.
/// `None` for merges.
fn patch_id(ctx: &Ctx, id: ObjectId) -> Result<Option<String>, Exit> {
    let c = ctx.repo.find_commit(id)?;
    let parents: Vec<ObjectId> = c.parent_ids().map(|p| p.detach()).collect();
    let base = match parents.as_slice() {
        [] => Flat::new(),
        [p] => commit_flat(ctx, &ctx.repo.find_commit(*p)?)?,
        _ => return Ok(None),
    };
    let (mut text, mut st) = (String::new(), crate::diff::Stats::default());
    crate::diff::diff_flats(ctx, &base, &commit_flat(ctx, &c)?, &mut text, &mut st)?;
    let id: String = text
        .lines()
        .filter(|l| !l.starts_with("index ") && !l.starts_with("@@"))
        .flat_map(|l| l.chars().filter(|c| !c.is_whitespace()).chain(['\n']))
        .collect();
    Ok(Some(id))
}

/// Pick the todo list's commits one by one until it is done (then finish) or one stops on a conflict.
fn run_todo(ctx: &Ctx) -> Res {
    let quiet = std::path::Path::new(&path("quiet")).exists();
    let xopts = saved_xopts();
    loop {
        let todo = parse_todo(ctx, &read("git-rebase-todo").unwrap_or_default())?;
        let Some(&next) = todo.first() else { return finish(ctx, quiet) };
        let msgnum = read("msgnum").and_then(|n| n.trim().parse::<usize>().ok()).unwrap_or(0) + 1;
        let end = read("end").and_then(|n| n.trim().parse::<usize>().ok()).unwrap_or(todo.len());
        let rest: String = todo[1..].iter().map(|id| todo_line(ctx, *id)).collect::<Result<_, _>>()?;
        write("git-rebase-todo", &rest)?;
        write("done", &(read("done").unwrap_or_default() + &todo_line(ctx, next)?))?;
        write("msgnum", &format!("{msgnum}\n"))?;
        if !quiet {
            eprint!("Rebasing ({msgnum}/{end})\r");
        }
        if !pick(ctx, next, &xopts)? {
            return Ok(1);
        }
    }
}

/// Replay one commit on HEAD. False when it stopped on a conflict (the state for `--continue` written).
fn pick(ctx: &Ctx, id: ObjectId, xopts: &[String]) -> Result<bool, Exit> {
    let c = ctx.repo.find_commit(id)?;
    let head = ctx.repo.head_commit()?;
    let parent = c.parent_ids().next().map(|p| p.detach());
    let h = commit_flat(ctx, &head)?;
    let summary = subject(&c);
    // on top of its own parent: the commit itself (the sequencer fast-forwards)
    if parent == Some(head.id) {
        let t = commit_flat(ctx, &c)?;
        two_way(ctx, &h, &t, "merge")?;
        detach(ctx, id, &format!("rebase (pick): {summary}"))?;
        return Ok(true);
    }
    let base_tree = match parent {
        Some(p) => ctx.repo.find_commit(p)?.tree_id()?.detach(),
        None => ctx.repo.empty_tree().id,
    };
    let theirs_label = format!("{} ({summary})", short(id));
    let ancestor_label = format!("parent of {theirs_label}");
    let labels = gix::merge::blob::builtin_driver::text::Labels {
        ancestor: Some(BStr::new(ancestor_label.as_str())),
        current: Some(BStr::new("HEAD")),
        other: Some(BStr::new(theirs_label.as_str())),
    };
    let mut outcome = ctx.repo.merge_trees(base_tree, head.tree_id()?.detach(), c.tree_id()?.detach(), labels, tree_options(ctx, xopts)?)?;
    let tree = outcome.tree.write()?.detach();
    let merged = flat_tree(ctx, tree)?;
    let conflicted = match apply_merged(ctx, &h, &merged, &outcome) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", e.msg);
            stop(ctx, &c, false)?;
            return Ok(false);
        }
    };
    if conflicted {
        // as the sequencer, merge-ort's messages only for a pick that stops
        for line in conflict_messages(&outcome.conflicts, "HEAD", &theirs_label) {
            out(&format!("{line}\n"));
        }
        stop(ctx, &c, true)?;
        return Ok(false);
    }
    // a commit whose changes HEAD already has is dropped (one that was empty to begin with is kept)
    if tree == head.tree_id()?.detach() && base_tree != c.tree_id()?.detach() {
        eprintln!("dropping {id} {summary} -- patch contents already upstream");
        return Ok(true);
    }
    commit_pick(ctx, &c, tree, head.id)?;
    Ok(true)
}

fn commit_pick(ctx: &Ctx, c: &gix::Commit<'_>, tree: ObjectId, parent: ObjectId) -> Result<ObjectId, Exit> {
    let committer = signature(ctx);
    let mut buf = gix::date::parse::TimeBuf::default();
    let message = c.message_raw_sloppy().to_str_lossy().into_owned();
    let new = ctx.repo.new_commit_as(committer.to_ref(&mut buf), c.author()?, message.as_str(), tree, [parent])?.id;
    detach(ctx, new, &format!("rebase (pick): {}", subject(c)))?;
    Ok(new)
}

/// Stop on `c`: what `--continue` needs and git's messages (sequencer.c's error_with_patch and the conflict advice).
fn stop(ctx: &Ctx, c: &gix::Commit<'_>, conflicted: bool) -> Result<(), Exit> {
    let message = c.message_raw_sloppy().to_str_lossy().into_owned();
    let paths: String = unmerged(&*load_index(ctx)?).keys().map(|p| format!("#\t{}\n", path_str(p))).collect();
    let merge_msg = if conflicted { format!("{}\n# Conflicts:\n{paths}", message.trim_end_matches('\n').to_string() + "\n") } else { message.clone() };
    write("message", &merge_msg)?;
    crate::merge::write_state("MERGE_MSG", &merge_msg)?;
    write("stopped-sha", &format!("{}\n", c.id))?;
    crate::merge::write_state("REBASE_HEAD", &format!("{}\n", c.id))?;
    let author = c.author()?;
    let time = author.time()?;
    let sign = if time.offset < 0 { '-' } else { '+' };
    let off = time.offset.abs();
    write(
        "author-script",
        &format!("GIT_AUTHOR_NAME='{}'\nGIT_AUTHOR_EMAIL='{}'\nGIT_AUTHOR_DATE='@{} {sign}{:02}{:02}'\n", author.name, author.email, time.seconds, off / 3600, off % 3600 / 60),
    )?;
    let line = format!("{}... {}", short(c.id), subject(c));
    eprintln!("error: could not apply {line}");
    if ctx.repo.config_snapshot().boolean("advice.mergeConflict").unwrap_or(true) {
        eprintln!(
            "hint: Resolve all conflicts manually, mark them as resolved with\nhint: \"git add/rm <conflicted_files>\", then run \"git rebase --continue\".\nhint: You can instead skip this commit: run \"git rebase --skip\".\nhint: To abort and get back to the state before \"git rebase\", run \"git rebase --abort\".\nhint: Disable this message with \"git config set advice.mergeConflict false\""
        );
    }
    eprintln!("Could not apply {}... # {}", short(c.id), subject(c));
    Ok(())
}

/// `--continue`: commit what was staged for the stopped commit (none: it is dropped), then go on.
fn continue_rebase(ctx: &Ctx) -> Res {
    let index = load_index(ctx)?;
    let conflicts = unmerged(&index);
    if !conflicts.is_empty() {
        for p in conflicts.keys() {
            out(&format!("{}: needs merge\n", path_str(p)));
        }
        out("You must edit all merge conflicts and then\nmark them as resolved using git add\n");
        return Ok(1);
    }
    let unstaged = worktree_changes(ctx, gix::status::UntrackedFiles::None)?.iter().any(|w| !matches!(w.kind, crate::status::Kind::Untracked));
    if unstaged {
        out("You must edit all merge conflicts and then\nmark them as resolved using git add\n");
        return Ok(1);
    }
    let stopped = read("stopped-sha").and_then(|s| ObjectId::from_hex(s.trim().as_bytes()).ok());
    let (h, idx) = (flat_head(ctx)?, flat_index(&index));
    if let Some(id) = stopped.filter(|_| h != idx) {
        let c = ctx.repo.find_commit(id)?;
        let head = ctx.repo.head_commit()?;
        let tree = crate::history::write_tree(ctx, &idx)?;
        let new = commit_pick(ctx, &c, tree, head.id)?;
        let message = c.message_raw_sloppy().to_str_lossy().into_owned();
        crate::history::summary(ctx, new, &h, &idx, &message, false)?;
    }
    clear_stop();
    run_todo(ctx)
}

/// `--skip`: drop the stopped commit's changes (back to HEAD), then go on.
fn skip(ctx: &Ctx) -> Res {
    hard_reset(ctx, &flat_head(ctx)?, true)?;
    clear_stop();
    run_todo(ctx)
}

/// `--abort`: back to the commit and branch the rebase started from.
fn abort(ctx: &Ctx) -> Res {
    let orig = read("orig-head").and_then(|s| ObjectId::from_hex(s.trim().as_bytes()).ok());
    let head_name = read("head-name").unwrap_or_default().trim().to_string();
    if let Some(orig) = orig {
        hard_reset(ctx, &commit_flat(ctx, &ctx.repo.find_commit(orig)?)?, true)?;
        match head_name.strip_prefix("refs/heads/") {
            Some(b) => set_head_branch(ctx, b, &format!("rebase (abort): returning to {head_name}"))?,
            None => detach(ctx, orig, "rebase (abort): returning to detached HEAD")?,
        }
    }
    clear_stop();
    let _ = std::fs::remove_file("/.git/REBASE_HEAD");
    std::fs::remove_dir_all(DIR)?;
    Ok(0)
}

/// All picked: the branch moves to HEAD and HEAD back onto it.
fn finish(ctx: &Ctx, quiet: bool) -> Res {
    let head_name = read("head-name").unwrap_or_default().trim().to_string();
    let onto = read("onto").unwrap_or_default().trim().to_string();
    let orig = read("orig-head").unwrap_or_default().trim().to_string();
    let head = ctx.repo.head_id()?.detach();
    let what = match head_name.strip_prefix("refs/heads/") {
        Some(b) => {
            let repo = crate::history::with_committer(ctx)?;
            repo.reference(head_name.as_str(), head, PreviousValue::Any, format!("rebase (finish): {head_name} onto {onto}"))?;
            set_head_branch(ctx, b, &format!("rebase (finish): returning to {head_name}"))?;
            head_name.clone()
        }
        None => "detached HEAD".to_string(),
    };
    if !orig.is_empty() {
        crate::merge::write_state("ORIG_HEAD", &format!("{orig}\n"))?;
    }
    clear_stop();
    std::fs::remove_dir_all(DIR)?;
    if !quiet {
        eprintln!("Successfully rebased and updated {what}.");
    }
    Ok(0)
}

/// `status`'s lines about a rebase in progress (wt-status.c's show_rebase_information and show_rebase_in_progress),
/// after its `interactive rebase in progress; onto <onto>` header.
pub fn status_lines(has_unmerged: bool) -> String {
    let abbrev = |line: &str| -> String {
        let mut w = line.splitn(3, ' ');
        match (w.next(), w.next(), w.next()) {
            (Some(cmd), Some(id), rest) if id.len() == 40 => format!("{cmd} {}{}", &id[..7], rest.map(|r| format!(" {r}")).unwrap_or_default()),
            _ => line.to_string(),
        }
    };
    let lines = |name: &str| -> Vec<String> { read(name).unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(abbrev).collect() };
    let (done, todo) = (lines("done"), lines("git-rebase-todo"));
    let mut s = String::new();
    let plural = |n: usize, one: &str, many: &str| if n == 1 { one.to_string() } else { many.to_string() };
    if done.is_empty() {
        s += "No commands done.\n";
    } else {
        s += &format!("{} ({} {} done):\n", plural(done.len(), "Last command done", "Last commands done"), done.len(), plural(done.len(), "command", "commands"));
        for l in &done[done.len().saturating_sub(2)..] {
            s += &format!("   {l}\n");
        }
        if done.len() > 2 {
            s += "  (see more in file .git/rebase-merge/done)\n";
        }
    }
    if todo.is_empty() {
        s += "No commands remaining.\n";
    } else {
        s += &format!("{} ({} {}):\n", plural(todo.len(), "Next command to do", "Next commands to do"), todo.len(), plural(todo.len(), "remaining command", "remaining commands"));
        for l in todo.iter().take(2) {
            s += &format!("   {l}\n");
        }
        s += "  (use \"git rebase --edit-todo\" to view and edit)\n";
    }
    let head_name = read("head-name").unwrap_or_default().trim().to_string();
    let onto = read("onto").unwrap_or_default().trim().chars().take(7).collect::<String>();
    let rebasing = match head_name.strip_prefix("refs/heads/") {
        Some(b) => format!("You are currently rebasing branch '{b}' on '{onto}'.\n"),
        None => "You are currently rebasing.\n".to_string(),
    };
    if has_unmerged {
        s += &rebasing;
        s += "  (fix conflicts and then run \"git rebase --continue\")\n  (use \"git rebase --skip\" to skip this patch)\n  (use \"git rebase --abort\" to check out the original branch)\n";
    } else if std::path::Path::new("/.git/MERGE_MSG").exists() {
        s += &rebasing;
        s += "  (all conflicts fixed: run \"git rebase --continue\")\n";
    } else {
        let branch = head_name.strip_prefix("refs/heads/").unwrap_or("");
        s += &format!("You are currently editing a commit while rebasing branch '{branch}' on '{onto}'.\n");
        s += "  (use \"git commit --amend\" to amend the current commit)\n  (use \"git rebase --continue\" once you are satisfied with your changes)\n";
    }
    s + "\n"
}

/// `interactive rebase in progress; onto <abbrev>`: status's header while rebasing.
pub fn status_header() -> Option<String> {
    in_progress().then(|| format!("interactive rebase in progress; onto {}\n", read("onto").unwrap_or_default().trim().chars().take(7).collect::<String>()))
}
