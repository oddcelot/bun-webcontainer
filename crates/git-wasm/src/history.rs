// commit, log, show, branch, rev-parse.
use crate::diff::{Stats, diff_flats};
use crate::status::{Status, branch_name, compute, flat_head, flat_index, flat_tree, load_index, long};
use crate::{Ctx, Res, Specs, error, fatal, index, out, positional};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::tree::EntryKind;

fn config_str(ctx: &Ctx, key: &str) -> Option<String> {
    ctx.repo.config_snapshot().string(key).map(|v| v.to_str_lossy().into_owned()).filter(|v| !v.is_empty())
}

fn identity(ctx: &Ctx) -> (String, String) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let name = config_str(ctx, "user.name").or_else(|| env("GIT_AUTHOR_NAME")).unwrap_or_else(|| "Playground".into());
    let email =
        config_str(ctx, "user.email").or_else(|| env("GIT_AUTHOR_EMAIL")).unwrap_or_else(|| "playground@runbun.dev".into());
    (name, email)
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn short(id: ObjectId) -> String {
    id.to_hex_with_len(7).to_string()
}

pub fn commit(ctx: &Ctx, args: &[String]) -> Res {
    let (mut msgs, mut all, mut allow_empty) = (Vec::new(), false, false);
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
            a if a.starts_with("--message=") => msgs.push(a["--message=".len()..].to_string()),
            a if a.starts_with("-m") && a.len() > 2 => msgs.push(a[2..].to_string()),
            _ => {}
        }
    }
    if msgs.is_empty() {
        return fatal("no commit message given: use -m <msg>");
    }
    if all {
        index::stage(ctx, &Specs::new(&[]), false)?;
    }
    let idx = load_index(ctx)?;
    let (head, flat) = (flat_head(ctx)?, flat_index(&idx));
    let parents: Vec<ObjectId> = ctx.repo.head_id().ok().map(|i| i.detach()).into_iter().collect();
    if head == flat && !allow_empty {
        let st: Status = compute(ctx)?;
        out(&long(ctx, &st)?);
        return Ok(1);
    }

    let mut editor = ctx.repo.edit_tree(ctx.repo.empty_tree().id)?;
    for (path, (mode, id)) in &flat {
        let kind = match mode & 0o170000 {
            0o120000 => EntryKind::Link,
            0o160000 => EntryKind::Commit,
            _ if mode & 0o111 != 0 => EntryKind::BlobExecutable,
            _ => EntryKind::Blob,
        };
        editor.upsert(path.as_bstr(), kind, *id)?;
    }
    let tree = editor.write()?.detach();

    let (name, email) = identity(ctx);
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let sig = gix::actor::Signature { name: name.as_str().into(), email: email.as_str().into(), time: gix::date::Time::new(secs, 0) };
    let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
    let mut message = msgs.join("\n\n");
    if !message.ends_with('\n') {
        message.push('\n');
    }
    let id = ctx.repo.commit_as(sig.to_ref(&mut b1), sig.to_ref(&mut b2), "HEAD", message.as_str(), tree, parents.clone())?.detach();

    let (mut diff_out, mut st) = (String::new(), Stats::default());
    diff_flats(ctx, &head, &flat, &mut diff_out, &mut st)?;
    let root = if parents.is_empty() { " (root-commit)" } else { "" };
    let summary = message.lines().next().unwrap_or("");
    out(&format!("[{}{root} {}] {summary}\n", branch_name(ctx)?, short(id)));
    let mut line = format!(" {}", plural(st.files, "file changed", "files changed"));
    if st.ins > 0 || st.del == 0 {
        line += &format!(", {}", plural(st.ins as usize, "insertion(+)", "insertions(+)"));
    }
    if st.del > 0 {
        line += &format!(", {}", plural(st.del as usize, "deletion(-)", "deletions(-)"));
    }
    out(&format!("{line}\n"));
    for (p, (m, _)) in &flat {
        if !head.contains_key(p) {
            out(&format!(" create mode {m:o} {}\n", p.to_str_lossy()));
        }
    }
    for (p, (m, _)) in &head {
        if !flat.contains_key(p) {
            out(&format!(" delete mode {m:o} {}\n", p.to_str_lossy()));
        }
    }
    Ok(0)
}

fn format_commit(ctx: &Ctx, c: &gix::Commit<'_>, oneline: bool) -> Result<String, crate::Exit> {
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

pub fn log(ctx: &Ctx, args: &[String]) -> Res {
    let oneline = args.iter().any(|a| a == "--oneline");
    let mut limit = usize::MAX;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let n = if a == "-n" || a == "--max-count" {
            it.next().cloned()
        } else if let Some(v) = a.strip_prefix("--max-count=").or_else(|| a.strip_prefix("-n")) {
            Some(v.to_string())
        } else {
            a.strip_prefix('-').filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())).map(String::from)
        };
        if let Some(n) = n {
            limit = n.parse().or_else(|_| fatal(format!("'{n}': not an integer")))?;
        }
    }
    let Ok(head) = ctx.repo.head_commit() else {
        return fatal(format!("your current branch '{}' does not have any commits yet", branch_name(ctx)?));
    };
    for (i, info) in head.ancestors().all()?.take(limit).enumerate() {
        let c = info?.object()?;
        if i > 0 && !oneline {
            out("\n");
        }
        out(&format_commit(ctx, &c, oneline)?);
    }
    Ok(0)
}

pub fn show(ctx: &Ctx, args: &[String]) -> Res {
    let spec = positional(args).into_iter().next().unwrap_or_else(|| "HEAD".into());
    let id = match ctx.repo.rev_parse_single(spec.as_str()) {
        Ok(id) => id.detach(),
        Err(_) => return fatal(format!("ambiguous argument '{spec}': unknown revision or path not in the working tree.")),
    };
    let c = ctx.repo.find_commit(id)?;
    out(&format_commit(ctx, &c, false)?);
    let old = match c.parent_ids().next() {
        Some(p) => flat_tree(ctx, ctx.repo.find_commit(p)?.tree_id()?.detach())?,
        None => Default::default(),
    };
    let new = flat_tree(ctx, c.tree_id()?.detach())?;
    let (mut d, mut st) = (String::new(), Stats::default());
    diff_flats(ctx, &old, &new, &mut d, &mut st)?;
    if !d.is_empty() {
        out("\n");
        out(&d);
    }
    Ok(0)
}

pub fn branch(ctx: &Ctx, args: &[String]) -> Res {
    let names = positional(args);
    if let Some(name) = names.first() {
        let Ok(head) = ctx.repo.head_id() else {
            return fatal("not a valid object name: 'HEAD'");
        };
        let full = format!("refs/heads/{name}");
        if ctx.repo.find_reference(full.as_str()).is_ok() {
            return fatal(format!("a branch named '{name}' already exists"));
        }
        // The reflog entry needs a committer.
        let (name, email) = identity(ctx);
        let mut repo = ctx.repo.clone();
        {
            let mut cfg = repo.config_snapshot_mut();
            cfg.set_raw_value_by("committer", None, "name", name.as_str())?;
            cfg.set_raw_value_by("committer", None, "email", email.as_str())?;
        }
        repo.reference(full, head.detach(), gix::refs::transaction::PreviousValue::MustNotExist, "branch: Created from HEAD")?;
        return Ok(0);
    }
    let current = ctx.repo.head_name()?.map(|n| n.shorten().to_str_lossy().into_owned());
    let mut list: Vec<String> = Vec::new();
    for r in ctx.repo.references()?.local_branches()? {
        let r = r.map_err(|e| crate::Exit { code: 128, msg: format!("fatal: {e}") })?;
        list.push(r.name().shorten().to_str_lossy().into_owned());
    }
    list.sort();
    for n in list {
        if current.as_deref() == Some(n.as_str()) {
            out(&format!("* {}\n", ctx.paint("32", &n)));
        } else {
            out(&format!("  {n}\n"));
        }
    }
    Ok(0)
}

pub fn rev_parse(ctx: &Ctx, args: &[String]) -> Res {
    let args = positional(args);
    if args.is_empty() {
        return Ok(0);
    }
    for a in &args {
        match ctx.repo.rev_parse_single(a.as_str()) {
            Ok(id) => out(&format!("{id}\n")),
            Err(_) => return fatal(format!("ambiguous argument '{a}': unknown revision or path not in the working tree.")),
        }
    }
    Ok(0)
}
