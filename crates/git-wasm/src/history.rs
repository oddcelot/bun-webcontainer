// commit, log, show, branch, rev-parse.
use crate::diff::{Stats, diff_flats};
use crate::status::{Status, branch_name, compute, flat_head, flat_index, load_index, long};
use crate::worktree::{commit_flat, move_head};
use crate::{Ctx, Exit, Res, Specs, error, fatal, index, out};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::tree::EntryKind;

fn config_str(ctx: &Ctx, key: &str) -> Option<String> {
    ctx.repo.config_snapshot().string(key).map(|v| v.to_str_lossy().into_owned()).filter(|v| !v.is_empty())
}

pub fn identity(ctx: &Ctx) -> (String, String) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let name = config_str(ctx, "user.name").or_else(|| env("GIT_AUTHOR_NAME")).unwrap_or_else(|| "Playground".into());
    let email =
        config_str(ctx, "user.email").or_else(|| env("GIT_AUTHOR_EMAIL")).unwrap_or_else(|| "playground@runbun.dev".into());
    (name, email)
}

/// A repository handle whose committer is the configured identity (reflog entries need one).
pub fn with_committer(ctx: &Ctx) -> Result<gix::Repository, Exit> {
    let (name, email) = identity(ctx);
    let mut repo = ctx.repo.clone();
    {
        let mut cfg = repo.config_snapshot_mut();
        cfg.set_raw_value_by("committer", None, "name", name.as_str())?;
        cfg.set_raw_value_by("committer", None, "email", email.as_str())?;
    }
    Ok(repo)
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn short(id: ObjectId) -> String {
    id.to_hex_with_len(7).to_string()
}

pub fn commit(ctx: &Ctx, args: &[String]) -> Res {
    let (mut msgs, mut all, mut allow_empty, mut amend, mut quiet) = (Vec::new(), false, false, false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-m" | "--message" => match it.next() {
                Some(m) => msgs.push(m.clone()),
                None => return error("switch `m' requires a value"),
            },
            "-am" | "-ma" => {
                all = true;
                match it.next() {
                    Some(m) => msgs.push(m.clone()),
                    None => return error("switch `m' requires a value"),
                }
            }
            "-a" | "--all" => all = true,
            "--allow-empty" => allow_empty = true,
            "--amend" => amend = true,
            "-q" | "--quiet" => quiet = true,
            "--no-edit" => {}
            a if a.starts_with("--message=") => msgs.push(a["--message=".len()..].to_string()),
            a if a.starts_with("-m") && a.len() > 2 => msgs.push(a[2..].to_string()),
            _ => {}
        }
    }
    let merging = crate::status::merging();
    if amend && merging {
        return fatal("You are in the middle of a merge -- cannot amend.");
    }
    let prev = if amend {
        Some(ctx.repo.head_commit().or_else(|_| fatal("You have nothing to amend."))?)
    } else {
        None
    };
    // a merge in progress: its other parents and its prepared message (as `--no-edit` takes it)
    let (merge_heads, merge_msg) = if merging { crate::merge::merge_heads()? } else { (Vec::new(), None) };
    // after `merge --squash`: SQUASH_MSG, then MERGE_MSG's conflicts when it stopped on them
    let merge_msg = match (merge_msg, std::fs::read_to_string("/.git/SQUASH_MSG").ok()) {
        (Some(m), squash) => Some(squash.unwrap_or_default() + &m),
        (None, squash) => squash.map(|s| s + &std::fs::read_to_string("/.git/MERGE_MSG").unwrap_or_default()),
    };
    if msgs.is_empty() && prev.is_none() && merge_msg.is_none() {
        return fatal("no commit message given: use -m <msg>");
    }
    if all {
        index::stage(ctx, &Specs::new(&[]), false)?;
    }
    let idx = load_index(ctx)?;
    let conflicts = crate::status::unmerged(&idx);
    if !conflicts.is_empty() {
        for p in conflicts.keys() {
            out(&format!("U\t{}\n", p.to_str_lossy()));
        }
        return Err(Exit {
            code: 128,
            msg: "error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.".into(),
        });
    }
    let (head, flat) = (flat_head(ctx)?, flat_index(&idx));
    let parents: Vec<ObjectId> = match &prev {
        Some(p) => p.parent_ids().map(|i| i.detach()).collect(),
        None => ctx.repo.head_id().ok().map(|i| i.detach()).into_iter().chain(merge_heads.iter().copied()).collect(),
    };
    // what the summary is relative to: the commit's parent when amending
    let base = match (&prev, parents.first()) {
        (Some(_), Some(p)) => commit_flat(ctx, &ctx.repo.find_commit(*p)?)?,
        (Some(_), None) => Default::default(),
        _ => head.clone(),
    };
    if head == flat && !allow_empty && !amend && !merging {
        let st: Status = compute(ctx)?;
        out(&long(ctx, &st)?);
        return Ok(1);
    }

    let tree = write_tree(ctx, &flat)?;

    let (name, email) = identity(ctx);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let sig = gix::actor::Signature { name: name.as_str().into(), email: email.as_str().into(), time: gix::date::Time::new(secs, 0) };
    let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
    let mut message = match (&prev, &merge_msg) {
        (Some(p), _) if msgs.is_empty() => p.message_raw_sloppy().to_str_lossy().into_owned(),
        (_, Some(m)) if msgs.is_empty() => cleanup_space(m),
        _ => msgs.join("\n\n"),
    };
    if !message.ends_with('\n') {
        message.push('\n');
    }
    if merging {
        let id = ctx.repo.new_commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), message.as_str(), tree, parents.clone())?.id;
        let summary = message.lines().next().unwrap_or("");
        move_head(ctx, id, &format!("commit (merge): {summary}"))?;
        crate::merge::clear_state();
        // like git, a merge commit's summary has no diffstat
        if !quiet {
            out(&format!("[{} {}] {summary}\n", summary_branch(ctx)?, short(id)));
        }
        return Ok(0);
    }
    let id = match &prev {
        Some(p) => {
            // amend keeps the author (and its date); the branch moves to the replacement
            let id = ctx.repo.new_commit_as(sig.to_ref(&mut b1), p.author()?, message.as_str(), tree, parents.clone())?.id;
            let summary = message.lines().next().unwrap_or("");
            move_head(ctx, id, &format!("commit (amend): {summary}"))?;
            id
        }
        None => ctx.repo.commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), "HEAD", message.as_str(), tree, parents.clone())?.detach(),
    };

    crate::merge::clear_state();
    if !quiet {
        summary(ctx, id, &base, &flat, &message, parents.is_empty())?;
    }
    Ok(0)
}

/// The branch a commit's summary names: `detached HEAD` when there is none.
fn summary_branch(ctx: &Ctx) -> Result<String, Exit> {
    Ok(match ctx.repo.head_name()? {
        Some(_) => branch_name(ctx)?,
        None => "detached HEAD".into(),
    })
}

/// commit's summary: `[main abc1234] subject`, the diffstat's last line and the creations, deletions and renames.
pub fn summary(ctx: &Ctx, id: ObjectId, base: &crate::status::Flat, flat: &crate::status::Flat, message: &str, root: bool) -> Result<(), Exit> {
    let (mut diff_out, mut st) = (String::new(), Stats::default());
    diff_flats(ctx, base, flat, &mut diff_out, &mut st)?;
    let root = if root { " (root-commit)" } else { "" };
    let summary = message.lines().next().unwrap_or("");
    out(&format!("[{}{root} {}] {summary}\n", summary_branch(ctx)?, short(id)));
    let mut line = format!(" {}", plural(st.files, "file changed", "files changed"));
    if st.ins > 0 || st.del == 0 {
        line += &format!(", {}", plural(st.ins as usize, "insertion(+)", "insertions(+)"));
    }
    if st.del > 0 {
        line += &format!(", {}", plural(st.del as usize, "deletion(-)", "deletions(-)"));
    }
    out(&format!("{line}\n"));
    // git's summary (diff.c show_file_mode_name, show_rename_copy): creations, deletions and renames by path.
    let renamed_to: std::collections::HashSet<String> = st.renames.iter().map(|r| r.1.clone()).collect();
    let renamed_from: std::collections::HashSet<String> = st.renames.iter().map(|r| r.0.clone()).collect();
    let mut lines: Vec<(String, String)> = Vec::new();
    for (p, (m, _)) in flat {
        if !base.contains_key(p) && !renamed_to.contains(&p.to_str_lossy().into_owned()) {
            lines.push((p.to_str_lossy().into_owned(), format!(" create mode {m:o} {}\n", p.to_str_lossy())));
        }
    }
    for (p, (m, _)) in base {
        if !flat.contains_key(p) && !renamed_from.contains(&p.to_str_lossy().into_owned()) {
            lines.push((p.to_str_lossy().into_owned(), format!(" delete mode {m:o} {}\n", p.to_str_lossy())));
        }
    }
    for (old, new, pct) in &st.renames {
        lines.push((new.clone(), format!(" rename {} ({pct}%)\n", crate::rename::pprint(old, new))));
    }
    lines.sort_by(|a, b| a.0.cmp(&b.0));
    for (_, l) in lines {
        out(&l);
    }
    Ok(())
}

/// git's `--cleanup=whitespace` (what `commit --no-edit` does to a prepared message): no trailing whitespace, no
/// leading, trailing or repeated blank lines.
fn cleanup_space(m: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for l in m.lines().map(str::trim_end) {
        if !(l.is_empty() && lines.last().is_none_or(|p| p.is_empty())) {
            lines.push(l);
        }
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Write a flat path map as a tree.
pub fn write_tree(ctx: &Ctx, flat: &crate::status::Flat) -> Result<ObjectId, Exit> {
    let mut editor = ctx.repo.edit_tree(ctx.repo.empty_tree().id)?;
    for (path, (mode, id)) in flat {
        let kind = match mode & 0o170000 {
            0o120000 => EntryKind::Link,
            0o160000 => EntryKind::Commit,
            _ if mode & 0o111 != 0 => EntryKind::BlobExecutable,
            _ => EntryKind::Blob,
        };
        editor.upsert(path.as_bstr(), kind, *id)?;
    }
    Ok(editor.write()?.detach())
}

/// The configured identity, now (UTC), as git writes it in commits and tags.
pub fn signature(ctx: &Ctx) -> gix::actor::Signature {
    let (name, email) = identity(ctx);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    gix::actor::Signature { name: name.as_str().into(), email: email.as_str().into(), time: gix::date::Time::new(secs, 0) }
}

pub fn format_commit(ctx: &Ctx, c: &gix::Commit<'_>, oneline: bool) -> Result<String, crate::Exit> {
    let id = c.id;
    let msg = c.message_raw_sloppy().to_str_lossy().into_owned();
    if oneline {
        let sum = msg.lines().next().unwrap_or("");
        return Ok(format!("{} {sum}\n", ctx.paint("33", &short(id))));
    }
    let author = c.author()?;
    let date = author.time()?.format_or_unix(gix::date::time::format::DEFAULT);
    let mut s = format!("{}\n", ctx.paint("33", &format!("commit {id}")));
    s += &format!("Author: {} <{}>\n", author.name.to_str_lossy(), author.email.to_str_lossy());
    s += &format!("Date:   {date}\n\n");
    for l in msg.trim_end_matches('\n').lines() {
        s += &format!("    {l}\n");
    }
    Ok(s)
}

/// git's `show_date_relative`.
fn relative(now: i64, then: i64) -> String {
    let n = |v: i64, one: &str, many: &str| format!("{v} {} ago", if v == 1 { one } else { many });
    let diff = now - then;
    if diff < 0 {
        return "in the future".into();
    }
    if diff < 90 {
        return n(diff, "second", "seconds");
    }
    let minutes = (diff + 30) / 60;
    if minutes < 90 {
        return n(minutes, "minute", "minutes");
    }
    let hours = (minutes + 30) / 60;
    if hours < 36 {
        return n(hours, "hour", "hours");
    }
    let days = (hours + 12) / 24;
    if days < 14 {
        return n(days, "day", "days");
    }
    if days < 70 {
        return n((days + 3) / 7, "week", "weeks");
    }
    if days < 365 {
        return n((days + 15) / 30, "month", "months");
    }
    if days < 1825 {
        let total = (days * 12 * 2 + 365) / (365 * 2);
        let (years, months) = (total / 12, total % 12);
        let y = n(years, "year", "years");
        return if months > 0 {
            format!("{}, {}", y.trim_end_matches(" ago"), n(months, "month", "months"))
        } else {
            y
        };
    }
    n((days + 183) / 365, "year", "years")
}

/// The commit message split like git does: the subject is the first paragraph on one line, the body the rest.
fn subject_body(msg: &str) -> (String, String) {
    let msg = msg.trim_start_matches('\n');
    let (head, rest) = msg.split_once("\n\n").unwrap_or((msg, ""));
    (head.trim_end().replace('\n', " "), rest.trim_start_matches('\n').to_string())
}

/// `--format` placeholders: `%H %h %T %t %P %p %an %ae %at %ad %ar` (and `c` for the committer), `%s %b %B %n %% %xNN`.
fn expand(c: &gix::Commit<'_>, fmt: &str, now: i64) -> Result<String, crate::Exit> {
    let msg = c.message_raw_sloppy().to_str_lossy().into_owned();
    let (subject, body) = subject_body(&msg);
    let ids = |abbrev: bool| {
        c.parent_ids().map(|p| if abbrev { short(p.detach()) } else { p.to_string() }).collect::<Vec<_>>().join(" ")
    };
    let who = |committer: bool, field: char| -> Result<String, crate::Exit> {
        let sig = if committer { c.committer()? } else { c.author()? };
        let time = sig.time()?;
        Ok(match field {
            'n' => sig.name.to_str_lossy().into_owned(),
            'e' => sig.email.to_str_lossy().into_owned(),
            't' => time.seconds.to_string(),
            'd' => time.format_or_unix(gix::date::time::format::DEFAULT),
            _ => relative(now, time.seconds),
        })
    };
    let mut o = String::new();
    let mut rest = fmt;
    while let Some(i) = rest.find('%') {
        o += &rest[..i];
        rest = &rest[i + 1..];
        let b = rest.as_bytes();
        let (text, used) = match b {
            [b'%', ..] => ("%".to_string(), 1),
            [b'n', ..] => ("\n".to_string(), 1),
            [b'x', h1, h2, ..] if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() => {
                (char::from(u8::from_str_radix(&rest[1..3], 16).unwrap_or(0)).to_string(), 3)
            }
            [w @ (b'a' | b'c'), f @ (b'n' | b'e' | b't' | b'd' | b'r'), ..] => (who(*w == b'c', *f as char)?, 2),
            [b'H', ..] => (c.id.to_string(), 1),
            [b'h', ..] => (short(c.id), 1),
            [b'T', ..] => (c.tree_id()?.to_string(), 1),
            [b't', ..] => (short(c.tree_id()?.detach()), 1),
            [b'P', ..] => (ids(false), 1),
            [b'p', ..] => (ids(true), 1),
            [b's', ..] => (subject.clone(), 1),
            [b'b', ..] => (body.clone(), 1),
            [b'B', ..] => (msg.clone(), 1),
            _ => ("%".to_string(), 0), // unknown: kept as written
        };
        o += &text;
        rest = &rest[used..];
    }
    o += rest;
    Ok(o)
}

/// Does the commit change any of `paths` (files or directories) against its parents?
fn touches(ctx: &Ctx, c: &gix::Commit<'_>, paths: &[String]) -> Result<bool, crate::Exit> {
    let at = |c: &gix::Commit<'_>| -> Result<Vec<Option<ObjectId>>, crate::Exit> {
        let tree = c.tree()?;
        paths
            .iter()
            .map(|p| {
                let p = p.trim_start_matches("./").trim_end_matches('/');
                if p.is_empty() || p == "." {
                    return Ok(Some(tree.id));
                }
                Ok(tree.lookup_entry_by_path(p)?.map(|e| e.object_id()))
            })
            .collect()
    };
    let mine = at(c)?;
    let mut parents = c.parent_ids().peekable();
    if parents.peek().is_none() {
        return Ok(mine.iter().any(Option::is_some));
    }
    for p in parents {
        if at(&ctx.repo.find_commit(p)?)? == mine {
            return Ok(false); // TREESAME to a parent: git follows that one and skips this commit
        }
    }
    Ok(true)
}

pub fn log(ctx: &Ctx, args: &[String]) -> Res {
    let (mut oneline, mut all, mut limit, mut skip) = (false, false, usize::MAX, 0usize);
    let mut fmt: Option<(String, bool)> = None; // (format, terminator semantics)
    let (mut revs, mut paths) = (Vec::new(), Vec::new());
    let num = |v: &str| -> Result<usize, crate::Exit> { v.parse().or_else(|_| fatal(format!("'{v}': not an integer"))) };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let a = a.as_str();
        match a {
            "--oneline" => oneline = true,
            "--all" => all = true,
            "--" => paths.extend(it.by_ref().cloned()),
            "-n" | "--max-count" => limit = num(it.next().map_or("", |v| v.as_str()))?,
            "--skip" => skip = num(it.next().map_or("", |v| v.as_str()))?,
            "--no-color" | "--no-decorate" | "--decorate" | "--no-merges" => {}
            _ if a.starts_with("--max-count=") => limit = num(&a[12..])?,
            _ if a.starts_with("--skip=") => skip = num(&a[7..])?,
            _ if a.starts_with("--format=") || a.starts_with("--pretty=") => {
                let v = &a[a.find('=').unwrap_or(0) + 1..];
                match v {
                    "oneline" => oneline = true,
                    _ if v.starts_with("format:") => fmt = Some((v[7..].to_string(), false)),
                    _ if v.starts_with("tformat:") => fmt = Some((v[8..].to_string(), true)),
                    _ if v.contains('%') || a.starts_with("--format=") => fmt = Some((v.to_string(), true)),
                    _ => {} // medium and the like: the default layout
                }
            }
            _ if a.starts_with("-n") && a[2..].bytes().all(|b| b.is_ascii_digit()) => limit = num(&a[2..])?,
            _ if a.len() > 1 && a.starts_with('-') && a[1..].bytes().all(|b| b.is_ascii_digit()) => limit = num(&a[1..])?,
            _ if a.starts_with('-') && a.len() > 1 => return Err(crate::Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            _ => revs.push(a.to_string()),
        }
    }
    let mut tips: Vec<ObjectId> = Vec::new();
    for r in &revs {
        match ctx.repo.rev_parse_single(r.as_str()) {
            Ok(id) => tips.push(id.object()?.peel_to_commit()?.id),
            Err(_) => return fatal(format!("ambiguous argument '{r}': unknown revision or path not in the working tree.")),
        }
    }
    if all {
        for r in ctx.repo.references()?.local_branches()? {
            let mut r = r.map_err(|e| crate::Exit { code: 128, msg: format!("fatal: {e}") })?;
            tips.push(r.peel_to_id()?.detach());
        }
    }
    if tips.is_empty() || all {
        if let Ok(h) = ctx.repo.head_id() {
            tips.push(h.detach());
        }
    }
    if tips.is_empty() {
        if all {
            return Ok(0);
        }
        return fatal(format!("your current branch '{}' does not have any commits yet", branch_name(ctx)?));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let order = gix::revision::walk::Sorting::ByCommitTime(gix::traverse::commit::simple::CommitTimeOrder::NewestFirst);
    let (mut shown, mut first) = (0usize, true);
    let mut skipped = 0;
    for info in ctx.repo.rev_walk(tips).sorting(order).all()? {
        let c = info?.object()?;
        if !paths.is_empty() && !touches(ctx, &c, &paths)? {
            continue;
        }
        if skipped < skip {
            skipped += 1;
            continue;
        }
        if shown == limit {
            break;
        }
        shown += 1;
        match &fmt {
            Some((f, terminated)) => {
                if !terminated && !first {
                    out("\n");
                }
                out(&expand(&c, f, now)?);
                if *terminated {
                    out("\n");
                }
            }
            None => {
                if !first && !oneline {
                    out("\n");
                }
                out(&format_commit(ctx, &c, oneline)?);
            }
        }
        first = false;
    }
    Ok(0)
}
