// `git tag`: list (with patterns, `-n`), create (lightweight, annotated with -a/-m), delete.
use crate::history::{short, signature};
use crate::{Ctx, Exit, Res, fatal, out};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::refs::transaction::PreviousValue;

/// git's wildmatch without WM_PATHNAME (as `tag -l` uses it): `*`, `?`, `[a-z]`, `[!x]`, `\` escapes.
pub fn glob(pat: &[u8], s: &[u8]) -> bool {
    match pat.first() {
        None => s.is_empty(),
        Some(b'*') => (0..=s.len()).any(|i| glob(&pat[1..], &s[i..])),
        Some(b'?') => !s.is_empty() && glob(&pat[1..], &s[1..]),
        Some(b'[') => {
            let Some(c) = s.first() else { return false };
            let mut i = 1;
            let negate = matches!(pat.get(1), Some(b'!' | b'^'));
            if negate {
                i += 1;
            }
            let mut hit = false;
            let mut first = true;
            while i < pat.len() && (first || pat[i] != b']') {
                first = false;
                if pat.get(i + 1) == Some(&b'-') && pat.get(i + 2).is_some_and(|e| *e != b']') {
                    hit |= pat[i] <= *c && *c <= pat[i + 2];
                    i += 3;
                } else {
                    hit |= pat[i] == *c;
                    i += 1;
                }
            }
            if i >= pat.len() {
                return pat[0] == *c && glob(&pat[1..], &s[1..]); // no closing bracket: a literal `[`
            }
            hit != negate && glob(&pat[i + 1..], &s[1..])
        }
        Some(b'\\') if pat.len() > 1 => s.first() == Some(&pat[1]) && glob(&pat[2..], &s[1..]),
        Some(p) => s.first() == Some(p) && glob(&pat[1..], &s[1..]),
    }
}

/// The tags, sorted by name: (name, the id the ref holds).
fn tags(ctx: &Ctx) -> Result<Vec<(String, ObjectId)>, Exit> {
    let mut list = Vec::new();
    for r in ctx.repo.references()?.tags()? {
        let r = r.map_err(|e| Exit { code: 128, msg: format!("fatal: {e}") })?;
        if let Some(id) = r.target().try_id() {
            list.push((r.name().shorten().to_str_lossy().into_owned(), id.to_owned()));
        }
    }
    list.sort();
    Ok(list)
}

/// The message `-n` shows: an annotated tag's, else the tagged commit's.
fn contents(ctx: &Ctx, id: ObjectId) -> Result<String, Exit> {
    let obj = ctx.repo.find_object(id)?;
    Ok(match obj.kind {
        gix::object::Kind::Tag => obj.into_tag().decode()?.message.to_str_lossy().into_owned(),
        gix::object::Kind::Commit => obj.into_commit().message_raw_sloppy().to_str_lossy().into_owned(),
        _ => String::new(),
    })
}

/// ref-filter's `%(contents:lines=N)`: the first `n` lines, the ones after the first indented by four spaces.
fn first_lines(text: &str, n: usize) -> String {
    let mut s = String::new();
    let mut rest = text.trim_end_matches(char::is_whitespace);
    for i in 0..n {
        if i > 0 {
            s += "\n    ";
        }
        match rest.split_once('\n') {
            Some((line, more)) => {
                s += line;
                rest = more;
            }
            None => {
                s += rest;
                break;
            }
        }
    }
    s
}

fn list(ctx: &Ctx, patterns: &[String], lines: Option<usize>) -> Res {
    for (name, id) in tags(ctx)? {
        if !patterns.is_empty() && !patterns.iter().any(|p| glob(p.as_bytes(), name.as_bytes())) {
            continue;
        }
        match lines {
            Some(n) => out(&format!("{name:<15} {}\n", first_lines(&contents(ctx, id)?, n))),
            None => out(&format!("{name}\n")),
        }
    }
    Ok(0)
}

fn delete(ctx: &Ctx, names: &[String]) -> Res {
    let mut code = 0;
    for name in names {
        match ctx.repo.try_find_reference(format!("refs/tags/{name}").as_str())? {
            Some(r) => {
                let was = r.target().try_id().map(|id| short(id.to_owned())).unwrap_or_default();
                r.delete()?;
                out(&format!("Deleted tag '{name}' (was {was})\n"));
            }
            None => {
                eprintln!("error: tag '{name}' not found.");
                code = 1;
            }
        }
    }
    Ok(code)
}

pub fn tag(ctx: &Ctx, args: &[String]) -> Res {
    let (mut annotate, mut force, mut del, mut list_mode) = (false, false, false, false);
    let (mut lines, mut msgs, mut pos) = (None, Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-a" | "--annotate" => annotate = true,
            "-f" | "--force" => force = true,
            "-d" | "--delete" => del = true,
            "-l" | "--list" => list_mode = true,
            "-n" => lines = Some(1),
            "-m" | "--message" => match it.next() {
                Some(m) => msgs.push(m.clone()),
                None => return Err(Exit { code: 129, msg: "error: switch `m' requires a value".into() }),
            },
            "--" => pos.extend(it.by_ref().cloned()),
            a if a.starts_with("--message=") => msgs.push(a[10..].to_string()),
            a if a.starts_with("-n") && a[2..].bytes().all(|b| b.is_ascii_digit()) => lines = Some(a[2..].parse().unwrap_or(1)),
            a if a.starts_with("-m") && a.len() > 2 => msgs.push(a[2..].to_string()),
            a if a.starts_with('-') && a.len() > 1 => return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) }),
            a => pos.push(a.to_string()),
        }
    }
    if del {
        return delete(ctx, &pos);
    }
    if list_mode || lines.is_some() || (pos.is_empty() && !annotate && msgs.is_empty()) {
        return list(ctx, &pos, lines);
    }
    let Some(name) = pos.first() else { return fatal("tag name required") };
    if pos.len() > 2 {
        return fatal("too many arguments");
    }
    let full = format!("refs/tags/{name}");
    if gix::refs::FullName::try_from(full.as_str()).is_err() || name.starts_with('-') {
        return fatal(format!("'{name}' is not a valid tag name."));
    }
    let target_spec = pos.get(1).map_or("HEAD", String::as_str);
    let Some(target) = ctx.repo.rev_parse_single(target_spec).ok().map(|id| id.detach()) else {
        return fatal(format!("Failed to resolve '{target_spec}' as a valid ref."));
    };
    let old = ctx.repo.try_find_reference(full.as_str())?.and_then(|r| r.target().try_id().map(|id| id.to_owned()));
    if old.is_some() && !force {
        return fatal(format!("tag '{name}' already exists"));
    }
    let id = if annotate || !msgs.is_empty() {
        if msgs.is_empty() {
            return fatal("no tag message?");
        }
        let kind = ctx.repo.find_object(target)?.kind;
        if kind == gix::object::Kind::Tag {
            eprintln!(
                "hint: You have created a nested tag. The object referred to by your new tag is\nhint: already a tag. If you meant to tag the object that it points to, use:\nhint:\nhint: \tgit tag -f {name} {target_spec}^{{}}\nhint: Disable this message with \"git config set advice.nestedTag false\""
            );
        }
        let mut message = msgs.iter().map(|m| m.trim_end()).collect::<Vec<_>>().join("\n\n").trim().to_string();
        if !message.is_empty() {
            message.push('\n');
        }
        let tag = gix::objs::Tag {
            target,
            target_kind: kind,
            name: name.as_str().into(),
            tagger: Some(signature(ctx)),
            message: message.into(),
            signature: None,
        };
        ctx.repo.write_object(&tag)?.detach()
    } else {
        target
    };
    ctx.repo.reference(full.as_str(), id, PreviousValue::Any, "tag")?;
    if let Some(old) = old.filter(|o| *o != id) {
        out(&format!("Updated tag '{name}' (was {})\n", short(old)));
    }
    Ok(0)
}
