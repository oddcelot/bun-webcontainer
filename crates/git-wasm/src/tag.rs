// `git tag`: list (with patterns, `-n`, `--sort`, `--contains`), create (lightweight, annotated with -a/-m), delete.
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

/// glibc's strverscmp, as git's versioncmp (without `versionsort.suffix`): digit runs compare as numbers, a run with
/// leading zeros as a fraction.
pub fn versioncmp(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    const S_N: usize = 0;
    const S_I: usize = 3;
    const S_F: usize = 6;
    const S_Z: usize = 9;
    const CMP: i8 = 2;
    const LEN: i8 = 3;
    const NEXT: [usize; 12] = [S_N, S_I, S_Z, S_N, S_I, S_I, S_N, S_F, S_F, S_N, S_F, S_Z];
    const RESULT: [i8; 36] = [
        CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP, //
        CMP, -1, -1, 1, LEN, LEN, 1, LEN, LEN, //
        CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, //
        CMP, 1, 1, -1, CMP, CMP, -1, CMP, CMP,
    ];
    let at = |s: &[u8], i: usize| s.get(i).copied().unwrap_or(0);
    let class = |c: u8| (c == b'0') as usize + c.is_ascii_digit() as usize;
    let (mut i, mut c1, mut c2) = (1, at(a, 0), at(b, 0));
    let mut state = S_N + class(c1);
    while c1 == c2 {
        if c1 == 0 {
            return Ordering::Equal;
        }
        state = NEXT[state];
        (c1, c2) = (at(a, i), at(b, i));
        i += 1;
        state += class(c1);
    }
    let diff = (c1 as i32).cmp(&(c2 as i32));
    match RESULT[state * 3 + class(c2)] {
        CMP => diff,
        LEN => {
            let mut j = i;
            while at(a, j).is_ascii_digit() {
                if !at(b, j).is_ascii_digit() {
                    return Ordering::Greater;
                }
                j += 1;
            }
            if at(b, j).is_ascii_digit() { Ordering::Less } else { diff }
        }
        r => r.cmp(&0),
    }
}

/// What a tag sorts by: `-` reverses, the last key given decides first, ties go by name.
struct SortKey {
    reverse: bool,
    field: String,
}

impl SortKey {
    fn parse(key: &str) -> Result<SortKey, Exit> {
        let (reverse, field) = match key.strip_prefix('-') {
            Some(f) => (true, f),
            None => (false, key),
        };
        let field = if field == "v:refname" { "version:refname" } else { field };
        if !matches!(field, "refname" | "version:refname" | "creatordate" | "objectname") {
            return fatal(format!("unknown field name: {field}"));
        }
        Ok(SortKey { reverse, field: field.to_string() })
    }
}

/// `creatordate`: an annotated tag's tagger date, a commit's committer date, else 0.
fn creator_date(ctx: &Ctx, id: ObjectId) -> i64 {
    let Ok(obj) = ctx.repo.find_object(id) else { return 0 };
    match obj.kind {
        gix::object::Kind::Tag => obj.into_tag().tagger().ok().flatten().and_then(|t| t.time().ok()).map_or(0, |t| t.seconds),
        gix::object::Kind::Commit => obj.into_commit().time().map_or(0, |t| t.seconds),
        _ => 0,
    }
}

/// The commit a tag names (through annotated tags), if it names one.
fn peeled_commit(ctx: &Ctx, id: ObjectId) -> Option<ObjectId> {
    ctx.repo.find_object(id).ok()?.peel_tags_to_end().ok().filter(|o| o.kind == gix::object::Kind::Commit).map(|o| o.id)
}

/// `--contains`/`--no-contains` take a commit, or HEAD as the last argument.
fn commit_arg(ctx: &Ctx, rev: &str) -> Result<ObjectId, Exit> {
    let usage = |msg: String| Exit { code: 129, msg };
    let id = ctx.repo.rev_parse_single(rev).map_err(|_| usage(format!("error: malformed object name {rev}")))?.detach();
    let obj = ctx.repo.find_object(id)?;
    match obj.peel_tags_to_end()? {
        o if o.kind == gix::object::Kind::Commit => Ok(o.id),
        o => Err(usage(format!("error: object {} is a {}, not a commit\nerror: no such commit {rev}", o.id, o.kind))),
    }
}

struct Filter {
    patterns: Vec<String>,
    lines: Option<usize>,
    sort: Vec<SortKey>,
    contains: Vec<ObjectId>,
    no_contains: Vec<ObjectId>,
}

fn list(ctx: &Ctx, f: &Filter) -> Res {
    let reaches = |tip: ObjectId, c: ObjectId| tip == c || ctx.repo.merge_base(c, tip).ok().flatten().is_some_and(|m| m.detach() == c);
    let mut picked = Vec::new();
    for (name, id) in tags(ctx)? {
        if !f.patterns.is_empty() && !f.patterns.iter().any(|p| glob(p.as_bytes(), name.as_bytes())) {
            continue;
        }
        if !f.contains.is_empty() || !f.no_contains.is_empty() {
            let Some(tip) = peeled_commit(ctx, id) else { continue };
            if !f.contains.is_empty() && !f.contains.iter().any(|c| reaches(tip, *c)) {
                continue;
            }
            if f.no_contains.iter().any(|c| reaches(tip, *c)) {
                continue;
            }
        }
        let date = if f.sort.iter().any(|k| k.field == "creatordate") { creator_date(ctx, id) } else { 0 };
        picked.push((name, id, date));
    }
    // tags() gives them by name, so a stable sort leaves ties in name order
    picked.sort_by(|a, b| {
        for k in f.sort.iter().rev() {
            let o = match k.field.as_str() {
                "version:refname" => versioncmp(a.0.as_bytes(), b.0.as_bytes()),
                "creatordate" => a.2.cmp(&b.2),
                "objectname" => a.1.cmp(&b.1),
                _ => a.0.cmp(&b.0),
            };
            let o = if k.reverse { o.reverse() } else { o };
            if o.is_ne() {
                return o;
            }
        }
        std::cmp::Ordering::Equal
    });
    for (name, id, _) in picked {
        match f.lines {
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
    let (mut sort, mut contains, mut no_contains) = (Vec::new(), Vec::new(), Vec::new());
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
            "--sort" => match it.next() {
                Some(k) => sort.push(SortKey::parse(k)?),
                None => return Err(Exit { code: 129, msg: "error: option `sort' requires a value".into() }),
            },
            a if a.starts_with("--sort=") => sort.push(SortKey::parse(&a[7..])?),
            "--no-sort" => sort.clear(),
            // a commit, or HEAD when it's the last argument
            "--contains" | "--no-contains" => {
                let rev = match it.next() {
                    Some(r) => r.clone(),
                    None => "HEAD".to_string(),
                };
                let list = if a == "--contains" { &mut contains } else { &mut no_contains };
                list.push(commit_arg(ctx, &rev)?);
            }
            a if a.starts_with("--contains=") => contains.push(commit_arg(ctx, &a[11..])?),
            a if a.starts_with("--no-contains=") => no_contains.push(commit_arg(ctx, &a[14..])?),
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
    if list_mode || lines.is_some() || !contains.is_empty() || !no_contains.is_empty() || (pos.is_empty() && !annotate && msgs.is_empty()) {
        if sort.is_empty() {
            if let Some(k) = ctx.repo.config_snapshot().string("tag.sort") {
                sort.push(SortKey::parse(&k.to_str_lossy())?);
            }
        }
        return list(ctx, &Filter { patterns: pos, lines, sort, contains, no_contains });
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
