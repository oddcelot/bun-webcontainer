// `git tag`: list (with patterns, `-n`, `--sort`, `--contains`, `--merged`, `--points-at`, `--format`), create
// (lightweight, annotated with -a/-m/-F), delete.
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
    merged: Vec<ObjectId>,
    no_merged: Vec<ObjectId>,
    points_at: Vec<ObjectId>,
    format: Option<Vec<Tok>>,
    icase: bool,
}

// ---- --format: ref-filter's atoms for tags ----------------------------------------------------------------------------

/// A piece of a `--format`: literal bytes, or an atom (`*` for the tagged object's).
enum Tok {
    Lit(Vec<u8>),
    Atom { deref: bool, name: String, arg: Option<String> },
}

const ATOMS: [&str; 21] = [
    "refname", "objectname", "objecttype", "objectsize", "tag", "type", "subject", "body", "contents", "taggername",
    "taggeremail", "taggerdate", "tagger", "authorname", "authoremail", "authordate", "committername", "committeremail",
    "committerdate", "creatordate", "creator",
];

/// Parse a format as ref-filter does: `%%`, `%xx` (hex), `%(atom[:arg])`; an unknown atom is fatal.
fn parse_format(fmt: &str) -> Result<Vec<Tok>, Exit> {
    let b = fmt.as_bytes();
    let (mut toks, mut lit, mut i) = (Vec::new(), Vec::new(), 0);
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match (b[i], b.get(i + 1)) {
            (b'%', Some(b'%')) => {
                lit.push(b'%');
                i += 2;
            }
            (b'%', Some(b'(')) => {
                let Some(end) = b[i..].iter().position(|c| *c == b')') else {
                    return Err(Exit { code: 128, msg: format!("error: malformed format string {}\nfatal: unable to parse format string", &fmt[i..]) });
                };
                let spec = &fmt[i + 2..i + end];
                i += end + 1;
                let (deref, spec) = match spec.strip_prefix('*') {
                    Some(s) => (true, s),
                    None => (false, spec),
                };
                let (name, arg) = match spec.split_once(':') {
                    Some((n, a)) => (n, Some(a.to_string())),
                    None => (spec, None),
                };
                if matches!(name, "align" | "if" | "then" | "else" | "end" | "color" | "upstream" | "push" | "symref" | "signature" | "trailers" | "describe" | "ahead-behind" | "is-base" | "worktreepath" | "rest" | "raw" | "HEAD" | "tree" | "parent" | "numparent" | "deltabase" | "object") {
                    return fatal(format!("%({name}) is not supported in the playground's tag --format"));
                }
                if !ATOMS.contains(&name) {
                    return fatal(format!("unknown field name: {name}"));
                }
                toks.push(Tok::Lit(std::mem::take(&mut lit)));
                toks.push(Tok::Atom { deref, name: name.to_string(), arg });
            }
            (b'%', Some(&h)) if hex(h).is_some() && b.get(i + 2).and_then(|c| hex(*c)).is_some() => {
                lit.push((hex(h).unwrap_or(0) * 16 + hex(b[i + 2]).unwrap_or(0)) as u8);
                i += 3;
            }
            (c, _) => {
                lit.push(c);
                i += 1;
            }
        }
    }
    toks.push(Tok::Lit(lit));
    Ok(toks)
}

/// The parts of a message ref-filter tells apart: the subject (the first paragraph, its lines joined by spaces), the
/// body (after the blank lines that follow it).
fn subject_body(msg: &str) -> (String, String) {
    let msg = msg.trim_start_matches('\n');
    let (subject, rest) = match msg.find("\n\n") {
        Some(i) => (&msg[..i], &msg[i..]),
        None => (msg.trim_end_matches('\n'), ""),
    };
    (subject.split('\n').collect::<Vec<_>>().join(" "), rest.trim_start_matches('\n').to_string())
}

fn date(time: Option<gix::date::Time>, arg: Option<&str>) -> Result<String, Exit> {
    use gix::date::time::format;
    let Some(t) = time else { return Ok(String::new()) };
    Ok(match arg {
        None | Some("default") => t.format_or_unix(format::DEFAULT),
        Some("short") => t.format_or_unix(format::SHORT),
        Some("iso" | "iso8601") => t.format_or_unix(format::ISO8601),
        Some("iso-strict" | "iso8601-strict") if t.offset == 0 => t.format_or_unix(format::ISO8601_STRICT).replace("+00:00", "Z"),
        Some("iso-strict" | "iso8601-strict") => t.format_or_unix(format::ISO8601_STRICT),
        Some("rfc" | "rfc2822") => t.format_or_unix(format::GIT_RFC2822),
        Some("unix") => t.format_or_unix(format::UNIX),
        Some("raw") => t.format_or_unix(format::RAW),
        Some(other) => return fatal(format!("date format '{other}' is not supported in the playground's tag --format")),
    })
}

/// One atom's value for the object `id` (a tag ref's target, or with `*` what an annotated tag points at).
fn atom(ctx: &Ctx, refname: &str, id: ObjectId, name: &str, arg: Option<&str>) -> Result<String, Exit> {
    let obj = ctx.repo.find_object(id)?;
    let kind = obj.kind;
    let data = obj.data.clone();
    let (mut message, mut tagger, mut author, mut committer, mut tag_name) = (String::new(), None, None, None, String::new());
    match kind {
        gix::object::Kind::Tag => {
            let t = gix::objs::TagRef::from_bytes(&data, ctx.repo.object_hash())?;
            message = t.message.to_str_lossy().into_owned();
            tag_name = t.name.to_str_lossy().into_owned();
            tagger = t.tagger()?.map(|s| s.to_owned()).transpose()?;
        }
        gix::object::Kind::Commit => {
            let c = gix::objs::CommitRef::from_bytes(&data, ctx.repo.object_hash())?;
            message = c.message.to_str_lossy().into_owned();
            author = Some(c.author()?.to_owned()?);
            committer = Some(c.committer()?.to_owned()?);
        }
        _ => {}
    }
    let who = |sig: &Option<gix::actor::Signature>, part: &str| -> Result<String, Exit> {
        let Some(sig) = sig else { return Ok(String::new()) };
        Ok(match part {
            "name" => sig.name.to_str_lossy().into_owned(),
            "email" if arg == Some("trim") => sig.email.to_str_lossy().into_owned(),
            "email" => format!("<{}>", sig.email),
            "date" => date(Some(sig.time), arg)?,
            _ => format!("{} <{}> {}", sig.name, sig.email, sig.time.format_or_unix(gix::date::time::format::RAW)),
        })
    };
    if message.trim_matches('\n').is_empty() {
        message.clear();
    }
    let (subject, body) = subject_body(&message);
    Ok(match name {
        "refname" => match arg {
            None => refname.to_string(),
            Some("short") => refname.trim_start_matches("refs/tags/").to_string(),
            Some(a) if a.starts_with("lstrip=") || a.starts_with("strip=") => {
                let n: usize = a[a.find('=').unwrap_or(0) + 1..].parse().map_err(|_| Exit { code: 128, msg: format!("fatal: positive value expected refname:{a}") })?;
                refname.split('/').skip(n).collect::<Vec<_>>().join("/")
            }
            Some(a) => return fatal(format!("unrecognized %(refname) argument: {a}")),
        },
        "objectname" => match arg {
            None => id.to_string(),
            Some("short") => short(id),
            Some(a) if a.starts_with("short=") => id.to_hex_with_len(a[6..].parse::<usize>().unwrap_or(7).clamp(4, 40)).to_string(),
            Some(a) => return fatal(format!("unrecognized %(objectname) argument: {a}")),
        },
        "objecttype" | "type" if name == "objecttype" || kind == gix::object::Kind::Tag => {
            if name == "type" { ctx.repo.find_object(id)?.into_tag().decode()?.target_kind.to_string() } else { kind.to_string() }
        }
        "type" => String::new(),
        "objectsize" => data.len().to_string(),
        "tag" => tag_name,
        "subject" => subject,
        "body" => body,
        "contents" => match arg {
            None => message,
            Some("subject") => subject,
            Some("body") => body,
            Some(a) if a.starts_with("lines=") => first_lines(&message, a[6..].parse().unwrap_or(0)),
            Some(a) => return fatal(format!("unrecognized %(contents) argument: {a}")),
        },
        "taggername" | "taggeremail" | "taggerdate" | "tagger" => who(&tagger, &name[6..])?,
        "authorname" | "authoremail" | "authordate" | "author" => who(&author, &name[6..])?,
        "committername" | "committeremail" | "committerdate" | "committer" => who(&committer, &name[9..])?,
        "creatordate" => date(tagger.as_ref().or(committer.as_ref()).map(|s| s.time), arg)?,
        "creator" => who(&tagger.or(committer), "")?,
        _ => String::new(),
    })
}

fn render(ctx: &Ctx, toks: &[Tok], name: &str, id: ObjectId) -> Result<Vec<u8>, Exit> {
    let refname = format!("refs/tags/{name}");
    let mut line = Vec::new();
    for t in toks {
        match t {
            Tok::Lit(b) => line.extend_from_slice(b),
            Tok::Atom { deref: false, name, arg } => line.extend_from_slice(atom(ctx, &refname, id, name, arg.as_deref())?.as_bytes()),
            Tok::Atom { deref: true, name, arg } => {
                let obj = ctx.repo.find_object(id)?;
                if obj.kind == gix::object::Kind::Tag {
                    let target = obj.into_tag().target_id()?.detach();
                    line.extend_from_slice(atom(ctx, &refname, target, name, arg.as_deref())?.as_bytes());
                }
            }
        }
    }
    line.push(b'\n');
    Ok(line)
}

fn list(ctx: &Ctx, f: &Filter) -> Res {
    let reaches = |tip: ObjectId, c: ObjectId| tip == c || ctx.repo.merge_base(c, tip).ok().flatten().is_some_and(|m| m.detach() == c);
    let mut picked = Vec::new();
    let lower = |s: &str| if f.icase { s.to_ascii_lowercase() } else { s.to_string() };
    for (name, id) in tags(ctx)? {
        if !f.patterns.is_empty() && !f.patterns.iter().any(|p| glob(lower(p).as_bytes(), lower(&name).as_bytes())) {
            continue;
        }
        // --points-at: the ref's own object, or what an annotated tag points at
        if !f.points_at.is_empty() {
            let tagged = ctx.repo.find_object(id).ok().filter(|o| o.kind == gix::object::Kind::Tag).and_then(|o| o.into_tag().target_id().ok().map(|t| t.detach()));
            if !f.points_at.iter().any(|p| *p == id || Some(*p) == tagged) {
                continue;
            }
        }
        if !f.merged.is_empty() || !f.no_merged.is_empty() {
            let Some(tip) = peeled_commit(ctx, id) else { continue };
            if !f.merged.is_empty() && !f.merged.iter().any(|m| reaches(*m, tip)) {
                continue;
            }
            if f.no_merged.iter().any(|m| reaches(*m, tip)) {
                continue;
            }
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
    // tags() gives them by name, so a stable sort leaves ties in name order (with -i, case-insensitive)
    if f.icase {
        picked.sort_by_key(|a| lower(&a.0));
    }
    picked.sort_by(|a, b| {
        for k in f.sort.iter().rev() {
            let o = match k.field.as_str() {
                "version:refname" => versioncmp(a.0.as_bytes(), b.0.as_bytes()),
                "creatordate" => a.2.cmp(&b.2),
                "objectname" => a.1.cmp(&b.1),
                _ => lower(&a.0).cmp(&lower(&b.0)),
            };
            let o = if k.reverse { o.reverse() } else { o };
            if o.is_ne() {
                return o;
            }
        }
        std::cmp::Ordering::Equal
    });
    for (name, id, _) in picked {
        match (&f.format, f.lines) {
            (Some(toks), _) => crate::out_bytes(&render(ctx, toks, &name, id)?),
            (None, Some(n)) => out(&format!("{name:<15} {}\n", first_lines(&contents(ctx, id)?, n))),
            (None, None) => out(&format!("{name}\n")),
        }
    }
    Ok(0)
}

/// The OS error as git prints it (`No such file or directory`), without Rust's ` (os error 2)`.
fn io_reason(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "No such file or directory".into(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".into(),
        std::io::ErrorKind::IsADirectory => "Is a directory".into(),
        _ => e.to_string(),
    }
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

/// git's strbuf_stripspace: trailing whitespace and `#` comment lines go, runs of blank lines become one, and
/// leading and trailing blank lines go.
fn stripspace(text: &str) -> String {
    let (mut s, mut blank) = (String::new(), false);
    for line in text.lines() {
        if line.starts_with('#') {
            continue;
        }
        let line = line.trim_end();
        if line.is_empty() {
            blank = !s.is_empty();
            continue;
        }
        if blank {
            s.push('\n');
            blank = false;
        }
        s += line;
        s.push('\n');
    }
    s
}

/// `--merged`/`--no-merged` take a commit, or HEAD as the last argument.
fn merged_arg(ctx: &Ctx, rev: &str) -> Result<ObjectId, Exit> {
    let id = ctx.repo.rev_parse_single(rev).map_err(|_| Exit { code: 128, msg: format!("fatal: malformed object name {rev}") })?.detach();
    peeled_commit(ctx, id).ok_or_else(|| Exit { code: 128, msg: format!("fatal: malformed object name {rev}") })
}

pub fn tag(ctx: &Ctx, args: &[String]) -> Res {
    let (mut annotate, mut force, mut del, mut list_mode, mut icase) = (false, false, false, false, false);
    let (mut lines, mut msgs, mut pos, mut file) = (None, Vec::new(), Vec::new(), None);
    let (mut sort, mut contains, mut no_contains) = (Vec::new(), Vec::new(), Vec::new());
    let (mut merged, mut no_merged, mut points_at, mut format) = (Vec::new(), Vec::new(), Vec::new(), None);
    // an option's value, or HEAD when it's the last argument
    let last_default = |it: &mut std::slice::Iter<String>| it.next().cloned().unwrap_or_else(|| "HEAD".into());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-a" | "--annotate" => annotate = true,
            "-f" | "--force" => force = true,
            "-d" | "--delete" => del = true,
            "-l" | "--list" => list_mode = true,
            "-i" | "--ignore-case" => icase = true,
            "-s" | "--sign" | "-u" | "--local-user" => return fatal("signed tags are not supported in the playground (there is no GPG or SSH key to sign with): make an annotated tag with -a"),
            a if a.starts_with("--local-user=") || a.starts_with("-u") => return fatal("signed tags are not supported in the playground (there is no GPG or SSH key to sign with): make an annotated tag with -a"),
            "-F" | "--file" => match it.next() {
                Some(f) => file = Some(f.clone()),
                None => return Err(Exit { code: 129, msg: if a == "-F" { "error: switch `F' requires a value".into() } else { "error: option `file' requires a value".into() } }),
            },
            a if a.starts_with("--file=") => file = Some(a[7..].to_string()),
            a if a.starts_with("-F") && a.len() > 2 => file = Some(a[2..].to_string()),
            "--format" => match it.next() {
                Some(f) => format = Some(parse_format(f)?),
                None => return Err(Exit { code: 129, msg: "error: option `format' requires a value".into() }),
            },
            a if a.starts_with("--format=") => format = Some(parse_format(&a[9..])?),
            "--merged" => merged.push(merged_arg(ctx, &last_default(&mut it))?),
            "--no-merged" => no_merged.push(merged_arg(ctx, &last_default(&mut it))?),
            a if a.starts_with("--merged=") => merged.push(merged_arg(ctx, &a[9..])?),
            a if a.starts_with("--no-merged=") => no_merged.push(merged_arg(ctx, &a[12..])?),
            "--points-at" | "--points-at=" => {
                let rev = if a == "--points-at" { last_default(&mut it) } else { a[12..].to_string() };
                match ctx.repo.rev_parse_single(rev.as_str()) {
                    Ok(id) => points_at.push(id.detach()),
                    Err(_) => return Err(Exit { code: 129, msg: format!("error: malformed object name '{rev}'") }),
                }
            }
            a if a.starts_with("--points-at=") => match ctx.repo.rev_parse_single(&a[12..]) {
                Ok(id) => points_at.push(id.detach()),
                Err(_) => return Err(Exit { code: 129, msg: format!("error: malformed object name '{}'", &a[12..]) }),
            },
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
    let filtering = !contains.is_empty() || !no_contains.is_empty() || !merged.is_empty() || !no_merged.is_empty() || !points_at.is_empty() || format.is_some();
    if list_mode || lines.is_some() || filtering || (pos.is_empty() && !annotate && msgs.is_empty() && file.is_none()) {
        if sort.is_empty() {
            if let Some(k) = ctx.repo.config_snapshot().string("tag.sort") {
                sort.push(SortKey::parse(&k.to_str_lossy())?);
            }
        }
        return list(ctx, &Filter { patterns: pos, lines, sort, contains, no_contains, merged, no_merged, points_at, format, icase });
    }
    if file.is_some() && !msgs.is_empty() {
        return fatal("options '-F' and '-m' cannot be used together");
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
    let from_file = match file.as_deref() {
        Some("-") => return fatal("-F - (the message on stdin) is not supported in the playground: write it to a file and use -F <file>"),
        Some(f) => {
            let path = std::path::Path::new("/").join(f.trim_start_matches('/'));
            Some(std::fs::read_to_string(&path).map_err(|e| Exit { code: 128, msg: format!("fatal: could not open or read '{f}': {}", io_reason(&e)) })?)
        }
        None => None,
    };
    let id = if annotate || !msgs.is_empty() || from_file.is_some() {
        if msgs.is_empty() && from_file.is_none() {
            return fatal("no tag message?");
        }
        let kind = ctx.repo.find_object(target)?.kind;
        if kind == gix::object::Kind::Tag {
            eprintln!(
                "hint: You have created a nested tag. The object referred to by your new tag is\nhint: already a tag. If you meant to tag the object that it points to, use:\nhint:\nhint: \tgit tag -f {name} {target_spec}^{{}}\nhint: Disable this message with \"git config set advice.nestedTag false\""
            );
        }
        let message = stripspace(&from_file.unwrap_or_else(|| msgs.join("\n\n")));
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
