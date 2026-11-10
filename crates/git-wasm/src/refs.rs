// show, branch, rev-parse: reading objects and refs by name.
use crate::diff::{Stats, diff_flats};
use crate::history::{format_commit, short, with_committer};
use crate::status::{flat_index, flat_tree, load_index};
use crate::worktree::{commit_flat, set_head_branch};
use crate::{Ctx, Exit, Res, fatal, out, out_bytes, positional};
use gix::bstr::ByteSlice;
use gix::refs::transaction::PreviousValue;

fn commit_of<'r>(ctx: &'r Ctx, spec: &str) -> Option<gix::Commit<'r>> {
    ctx.repo.rev_parse_single(spec).ok()?.object().ok()?.peel_to_commit().ok()
}

/// `<rev>:<path>` and `:<path>` print the blob as it is (a tree lists its entries).
fn show_path(ctx: &Ctx, spec: &str) -> Res {
    if let Some(path) = spec.strip_prefix(':') {
        let path = path.strip_prefix("0:").unwrap_or(path).trim_start_matches("./");
        let idx = flat_index(&load_index(ctx)?);
        let Some((_, id)) = idx.get(gix::bstr::BStr::new(path)) else {
            return if std::path::Path::new("/").join(path).exists() {
                fatal(format!("path '{path}' exists on disk, but not in the index"))
            } else {
                fatal(format!("path '{path}' does not exist (neither on disk nor in the index)"))
            };
        };
        out_bytes(&ctx.repo.find_object(*id)?.detach().data);
        return Ok(0);
    }
    let (rev, path) = spec.split_once(':').unwrap_or((spec, ""));
    let Some(commit) = commit_of(ctx, rev) else { return fatal(format!("invalid object name '{rev}'.")) };
    let path = path.trim_start_matches("./").trim_end_matches('/');
    let tree = commit.tree()?;
    let entry = if path.is_empty() { None } else { tree.lookup_entry_by_path(path)? };
    let (mode, id) = match &entry {
        Some(e) => (e.mode(), e.object_id()),
        None if path.is_empty() => (gix::objs::tree::EntryKind::Tree.into(), tree.id),
        None => return fatal(format!("path '{path}' does not exist in '{rev}'")),
    };
    if mode.is_tree() {
        let mut s = format!("tree {spec}\n\n");
        for e in flat_names(ctx, id)? {
            s += &format!("{e}\n");
        }
        out(&s);
    } else {
        out_bytes(&ctx.repo.find_object(id)?.detach().data);
    }
    Ok(0)
}

fn flat_names(ctx: &Ctx, tree: gix::ObjectId) -> Result<Vec<String>, Exit> {
    Ok(ctx
        .repo
        .find_tree(tree)?
        .iter()
        .filter_map(|e| e.ok())
        .map(|e| format!("{}{}", e.filename().to_str_lossy(), if e.mode().is_tree() { "/" } else { "" }))
        .collect())
}

pub fn show(ctx: &Ctx, args: &[String]) -> Res {
    let spec = positional(args).into_iter().next().unwrap_or_else(|| "HEAD".into());
    if spec.starts_with(':') && !spec.starts_with(":/") || spec.split_once(':').is_some_and(|(r, _)| !r.is_empty()) {
        return show_path(ctx, &spec);
    }
    let Some(c) = commit_of(ctx, &spec) else {
        return fatal(format!("ambiguous argument '{spec}': unknown revision or path not in the working tree."));
    };
    out(&format_commit(ctx, &c, false)?);
    let old = match c.parent_ids().next() {
        Some(p) => flat_tree(ctx, ctx.repo.find_commit(p)?.tree_id()?.detach())?,
        None => Default::default(),
    };
    let new = commit_flat(ctx, &c)?;
    let (mut d, mut st) = (String::new(), Stats::default());
    diff_flats(ctx, &old, &new, &mut d, &mut st)?;
    if !d.is_empty() {
        out("\n");
        out(&d);
    }
    Ok(0)
}

fn current(ctx: &Ctx) -> Result<Option<String>, Exit> {
    Ok(ctx.repo.head_name()?.map(|n| n.shorten().to_str_lossy().into_owned()))
}

fn branches(ctx: &Ctx) -> Result<Vec<(String, gix::ObjectId)>, Exit> {
    let mut list = Vec::new();
    for r in ctx.repo.references()?.local_branches()? {
        let mut r = r.map_err(|e| Exit { code: 128, msg: format!("fatal: {e}") })?;
        let id = r.peel_to_id()?.detach();
        list.push((r.name().shorten().to_str_lossy().into_owned(), id));
    }
    list.sort();
    Ok(list)
}

/// A few `for-each-ref` atoms: `%(refname)`, `%(refname:short)`, `%(objectname)`, `%(objectname:short)`, `%(HEAD)`.
fn expand(fmt: &str, name: &str, id: gix::ObjectId, is_current: bool) -> String {
    fmt.replace("%(refname:short)", name)
        .replace("%(refname)", &format!("refs/heads/{name}"))
        .replace("%(objectname:short)", &short(id))
        .replace("%(objectname)", &id.to_string())
        .replace("%(HEAD)", if is_current { "*" } else { " " })
}

fn delete(ctx: &Ctx, names: &[String], force: bool) -> Res {
    if names.is_empty() {
        return fatal("branch name required");
    }
    let (cur, mut code) = (current(ctx)?, 0);
    for name in names {
        if cur.as_deref() == Some(name.as_str()) {
            eprintln!("error: cannot delete branch '{name}' used by worktree at '/'");
            code = 1;
            continue;
        }
        let Ok(mut r) = ctx.repo.find_reference(format!("refs/heads/{name}").as_str()) else {
            eprintln!("error: branch '{name}' not found.");
            code = 1;
            continue;
        };
        let tip = r.peel_to_id()?.detach();
        if !force {
            // "fully merged" is judged against HEAD (there is no upstream)
            let merged = ctx.repo.head_id().ok().and_then(|h| ctx.repo.merge_base(tip, h.detach()).ok()).flatten().is_some_and(|b| b.detach() == tip);
            if !merged {
                eprintln!("error: the branch '{name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D {name}'");
                code = 1;
                continue;
            }
        }
        r.delete()?;
        out(&format!("Deleted branch {name} (was {}).\n", short(tip)));
    }
    Ok(code)
}

fn rename(ctx: &Ctx, names: &[String], force: bool) -> Res {
    let cur = current(ctx)?;
    let (old, new) = match names {
        [new] => (cur.clone().unwrap_or_default(), new),
        [old, new] => (old.clone(), new),
        _ => return fatal("branch name required"),
    };
    if old != *new && ctx.repo.try_find_reference(format!("refs/heads/{new}").as_str())?.is_some() && !force {
        return fatal(format!("a branch named '{new}' already exists"));
    }
    let tip = match ctx.repo.try_find_reference(format!("refs/heads/{old}").as_str())? {
        Some(mut r) => Some(r.peel_to_id()?.detach()),
        None if cur.as_deref() == Some(old.as_str()) => None, // unborn
        None => return fatal(format!("no branch named '{old}'")),
    };
    if old == *new {
        return Ok(0);
    }
    if let Some(tip) = tip {
        with_committer(ctx)?.reference(format!("refs/heads/{new}"), tip, PreviousValue::Any, format!("branch: renamed {old} to {new}"))?;
        ctx.repo.find_reference(format!("refs/heads/{old}").as_str())?.delete()?;
    }
    if cur.as_deref() == Some(old.as_str()) {
        set_head_branch(ctx, new, &format!("branch: renamed refs/heads/{old} to refs/heads/{new}"))?;
    }
    Ok(0)
}

pub fn branch(ctx: &Ctx, args: &[String]) -> Res {
    let (mut del, mut force, mut mv, mut show_current, mut list) = (false, false, false, false, false);
    let mut format = None;
    for a in args {
        match a.as_str() {
            "-d" | "--delete" => del = true,
            "-D" => (del, force) = (true, true),
            "-m" | "--move" => mv = true,
            "-M" => (mv, force) = (true, true),
            "-f" | "--force" => force = true,
            "-l" | "--list" => list = true,
            "--show-current" => show_current = true,
            "-a" | "--all" | "-v" | "-q" | "--quiet" | "--no-color" => {}
            a if a.starts_with("--format=") => format = Some(a[9..].to_string()),
            a if a.starts_with('-') && a.len() > 1 && a != "--" => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            _ => {}
        }
    }
    let names = positional(args);
    if show_current {
        if let Some(n) = current(ctx)? {
            out(&format!("{n}\n"));
        }
        return Ok(0);
    }
    if del {
        return delete(ctx, &names, force);
    }
    if mv {
        return rename(ctx, &names, force);
    }
    if let (Some(name), false) = (names.first(), list) {
        let start = names.get(1).map_or("HEAD", String::as_str);
        let Some(c) = commit_of(ctx, start) else {
            return fatal(if start == "HEAD" { "not a valid object name: 'HEAD'".into() } else { format!("not a valid object name: '{start}'") });
        };
        let full = format!("refs/heads/{name}");
        if ctx.repo.find_reference(full.as_str()).is_ok() {
            return fatal(format!("a branch named '{name}' already exists"));
        }
        with_committer(ctx)?.reference(full, c.id, PreviousValue::MustNotExist, format!("branch: Created from {start}"))?;
        return Ok(0);
    }
    let cur = current(ctx)?;
    if let (None, Ok(id), None) = (&cur, ctx.repo.head_id(), &format) {
        out(&format!("* {}\n", ctx.paint("32", &format!("(HEAD detached at {})", short(id.detach())))));
    }
    for (n, id) in branches(ctx)? {
        let is_current = cur.as_deref() == Some(n.as_str());
        match &format {
            Some(f) => out(&format!("{}\n", expand(f, &n, id, is_current))),
            None if is_current => out(&format!("* {}\n", ctx.paint("32", &n))),
            None => out(&format!("  {n}\n")),
        }
    }
    Ok(0)
}

pub fn rev_parse(ctx: &Ctx, args: &[String]) -> Res {
    let (mut verify, mut quiet, mut abbrev_ref, mut short_len) = (false, false, false, None);
    let mut revs = Vec::new();
    for a in args {
        match a.as_str() {
            "--verify" => verify = true,
            "-q" | "--quiet" => quiet = true,
            "--abbrev-ref" => abbrev_ref = true,
            "--short" => short_len = Some(7),
            "--show-toplevel" => out("/\n"),
            "--is-inside-work-tree" => out("true\n"),
            "--git-dir" => out(".git\n"),
            "--" => {}
            a if a.starts_with("--short=") => short_len = a[8..].parse().ok().or(Some(7)),
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => revs.push(a.to_string()),
        }
    }
    if verify && revs.len() != 1 {
        return if quiet { Ok(1) } else { fatal("Needed a single revision") };
    }
    for a in &revs {
        if abbrev_ref {
            match (a.as_str(), current(ctx)?) {
                ("HEAD", Some(n)) if ctx.repo.head_id().is_ok() => out(&format!("{n}\n")),
                ("HEAD", None) if ctx.repo.head_id().is_ok() => out("HEAD\n"),
                ("HEAD", _) => {
                    out("HEAD\n"); // like git: the name goes out, then the failure
                    return fatal("ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
                }
                (n, _) if ctx.repo.try_find_reference(format!("refs/heads/{n}").as_str()).ok().flatten().is_some() => out(&format!("{n}\n")),
                (n, _) => match ctx.repo.rev_parse_single(n) {
                    Ok(id) => out(&format!("{id}\n")),
                    Err(_) => return fatal(format!("ambiguous argument '{n}': unknown revision or path not in the working tree.")),
                },
            }
            continue;
        }
        match ctx.repo.rev_parse_single(a.as_str()) {
            Ok(id) => match short_len {
                Some(n) => out(&format!("{}\n", id.detach().to_hex_with_len(n.clamp(4, 40)))),
                None => out(&format!("{id}\n")),
            },
            Err(_) if verify && quiet => return Ok(1),
            Err(_) if verify => return fatal(format!("Needed a single revision")),
            Err(_) => return fatal(format!("ambiguous argument '{a}': unknown revision or path not in the working tree.")),
        }
    }

    Ok(0)
}
