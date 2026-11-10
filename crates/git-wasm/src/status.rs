// Trees, the index and the worktree as flat path maps, and `git status`.
use crate::{Ctx, Res, path_str};
use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use std::collections::BTreeMap;

/// path -> (mode as octal bits, blob id)
pub type Flat = BTreeMap<BString, (u32, ObjectId)>;

pub fn flat_tree(ctx: &Ctx, tree: ObjectId) -> Result<Flat, crate::Exit> {
    let tree = ctx.repo.find_tree(tree)?;
    let mut rec = gix::traverse::tree::Recorder::default();
    tree.traverse().breadthfirst(&mut rec)?;
    Ok(rec
        .records
        .into_iter()
        .filter(|e| !e.mode.is_tree())
        .map(|e| (e.filepath, (e.mode.value() as u32, e.oid)))
        .collect())
}

pub fn flat_head(ctx: &Ctx) -> Result<Flat, crate::Exit> {
    match ctx.repo.head_tree_id() {
        Ok(id) => flat_tree(ctx, id.detach()),
        Err(_) => Ok(Flat::new()),
    }
}

pub fn flat_index(index: &gix::index::File) -> Flat {
    index
        .entries()
        .iter()
        .filter(|e| e.stage_raw() == 0)
        .map(|e| (e.path(index).to_owned(), (e.mode.bits(), e.id)))
        .collect()
}

pub fn load_index(ctx: &Ctx) -> Result<gix::index::File, crate::Exit> {
    match ctx.repo.open_index() {
        Ok(i) => Ok(i),
        Err(_) => Ok(gix::index::File::from_state(
            gix::index::State::new(ctx.repo.object_hash()),
            ctx.repo.index_path(),
        )),
    }
}

#[derive(PartialEq, Clone, Copy)]
pub enum Kind {
    Modified,
    Deleted,
    Untracked,
}

pub struct Wt {
    pub path: BString,
    pub kind: Kind,
    pub is_dir: bool,
    /// the index entry (mode, id) for tracked changes
    pub entry: Option<(u32, ObjectId)>,
}

/// Index vs worktree. `Files` lists untracked files one by one (for `add`), `Collapsed` folds directories.
pub fn worktree_changes(ctx: &Ctx, untracked: gix::status::UntrackedFiles) -> Result<Vec<Wt>, crate::Exit> {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
    let platform = ctx
        .repo
        .status(gix::progress::Discard)?
        .untracked_files(untracked)
        .index_worktree_rewrites(None);
    let mut items = Vec::new();
    for item in platform.into_index_worktree_iter(Vec::<BString>::new())? {
        match item? {
            Item::Modification { entry, rela_path, status, .. } => {
                let kind = match status {
                    EntryStatus::Change(Change::Removed) => Kind::Deleted,
                    EntryStatus::Change(_) => Kind::Modified,
                    _ => continue,
                };
                items.push(Wt { path: rela_path, kind, is_dir: false, entry: Some((entry.mode.bits(), entry.id)) });
            }
            Item::DirectoryContents { entry, .. } => {
                if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                    let is_dir = matches!(entry.disk_kind, Some(gix::dir::entry::Kind::Directory));
                    items.push(Wt { path: entry.rela_path, kind: Kind::Untracked, is_dir, entry: None });
                }
            }
            Item::Rewrite { .. } => {}
        }
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(items)
}

pub struct Status {
    /// (path, 'A' | 'M' | 'D' | 'T')
    pub staged: Vec<(String, char)>,
    pub unstaged: Vec<(String, char)>,
    pub untracked: Vec<String>,
}

pub fn compute(ctx: &Ctx) -> Result<Status, crate::Exit> {
    compute_with(ctx, gix::status::UntrackedFiles::Collapsed)
}

pub fn compute_with(ctx: &Ctx, mode: gix::status::UntrackedFiles) -> Result<Status, crate::Exit> {
    let index = load_index(ctx)?;
    let (head, idx) = (flat_head(ctx)?, flat_index(&index));
    let mut staged = Vec::new();
    for (p, (m, id)) in &idx {
        match head.get(p) {
            None => staged.push((path_str(p), 'A')),
            Some((hm, hid)) if hm != m || hid != id => {
                let kind = if (hm & 0o170000) != (m & 0o170000) { 'T' } else { 'M' };
                staged.push((path_str(p), kind))
            }
            _ => {}
        }
    }
    for p in head.keys() {
        if !idx.contains_key(p) {
            staged.push((path_str(p), 'D'));
        }
    }
    staged.sort();
    let (mut unstaged, mut untracked) = (Vec::new(), Vec::new());
    for w in worktree_changes(ctx, mode)? {
        let p = path_str(&w.path);
        match w.kind {
            Kind::Modified => unstaged.push((p, 'M')),
            Kind::Deleted => unstaged.push((p, 'D')),
            Kind::Untracked => untracked.push(if w.is_dir { format!("{p}/") } else { p }),
        }
    }
    Ok(Status { staged, unstaged, untracked })
}

pub fn branch_name(ctx: &Ctx) -> Result<String, crate::Exit> {
    Ok(match ctx.repo.head_name()? {
        Some(n) => n.shorten().to_str_lossy().into_owned(),
        None => "HEAD".into(),
    })
}

fn label(c: char) -> &'static str {
    match c {
        'A' => "new file:   ",
        'D' => "deleted:    ",
        'T' => "typechange: ",
        _ => "modified:   ",
    }
}

/// The long format, ending in git's closing hint. Returns whether there is anything staged.
pub fn long(ctx: &Ctx, st: &Status) -> Result<String, crate::Exit> {
    let mut s = String::new();
    let branch = ctx.repo.head_name()?;
    match &branch {
        Some(n) => s += &format!("On branch {}\n", n.shorten().to_str_lossy()),
        None => {
            let id = ctx.repo.head_id().map(|i| i.shorten_or_id().to_string()).unwrap_or_default();
            s += &format!("HEAD detached at {id}\n");
        }
    }
    let unborn = ctx.repo.head_id().is_err();
    if unborn {
        s += "\nNo commits yet\n";
    }
    if !st.staged.is_empty() {
        s += "\nChanges to be committed:\n";
        s += &if unborn {
            "  (use \"git rm --cached <file>...\" to unstage)\n".to_string()
        } else {
            "  (use \"git restore --staged <file>...\" to unstage)\n".to_string()
        };
        for (p, c) in &st.staged {
            s += &ctx.paint("32", &format!("\t{}{}", label(*c), quote_path(p, false)));
            s += "\n";
        }
    }
    if !st.unstaged.is_empty() {
        s += "\nChanges not staged for commit:\n";
        s += "  (use \"git add/rm <file>...\" to update what will be committed)\n";
        for (p, c) in &st.unstaged {
            s += &ctx.paint("31", &format!("\t{}{}", label(*c), quote_path(p, false)));
            s += "\n";
        }
    }
    if !st.untracked.is_empty() {
        s += "\nUntracked files:\n";
        s += "  (use \"git add <file>...\" to include in what will be committed)\n";
        for p in &st.untracked {
            s += &ctx.paint("31", &format!("\t{}", quote_path(p, false)));
            s += "\n";
        }
    }
    let clean = st.staged.is_empty() && st.unstaged.is_empty() && st.untracked.is_empty();
    if !(clean && !unborn) {
        s += "\n";
    }
    if !st.staged.is_empty() {
        // git prints nothing more
        s.pop();
    } else if !st.unstaged.is_empty() {
        s += "no changes added to commit (use \"git add\" and/or \"git commit -a\")\n";
    } else if !st.untracked.is_empty() {
        s += "nothing added to commit but untracked files present (use \"git add\" to track)\n";
    } else if unborn {
        s += "nothing to commit (create/copy files and use \"git add\" to track)\n";
    } else {
        s += "nothing to commit, working tree clean\n";
    }
    Ok(s)
}

/// git's `quote_path`: C-style quoting of control characters, `"`, `\` and non-ASCII bytes (`core.quotePath`);
/// `sp` also quotes spaces, as the short format does.
pub fn quote_path(p: &str, sp: bool) -> String {
    let needs = |b: u8| b < 0x20 || b == b'"' || b == b'\\' || b >= 0x7f || (sp && b == b' ');
    if !p.bytes().any(needs) {
        return p.to_string();
    }
    let mut s = String::from("\"");
    for b in p.bytes() {
        match b {
            b'"' => s += "\\\"",
            b'\\' => s += "\\\\",
            7 => s += "\\a",
            8 => s += "\\b",
            9 => s += "\\t",
            10 => s += "\\n",
            11 => s += "\\v",
            12 => s += "\\f",
            13 => s += "\\r",
            b if b < 0x20 || b >= 0x7f => s += &format!("\\{b:03o}"),
            b => s.push(b as char),
        }
    }
    s.push('"');
    s
}

/// `## main`, `## No commits yet on main`, `## HEAD (no branch)`.
fn branch_header(ctx: &Ctx) -> Result<String, crate::Exit> {
    Ok(match ctx.repo.head_name()? {
        Some(n) => {
            let n = n.shorten().to_str_lossy().into_owned();
            if ctx.repo.head_id().is_err() { format!("No commits yet on {n}") } else { n }
        }
        None => "HEAD (no branch)".into(),
    })
}

pub fn status(ctx: &Ctx, args: &[String]) -> Res {
    use gix::status::UntrackedFiles as U;
    let (mut short, mut porcelain, mut z, mut branch) = (false, false, false, false);
    let mut untracked = U::Collapsed;
    for a in args {
        match a.as_str() {
            "-s" | "--short" => short = true,
            "--porcelain" | "--porcelain=v1" | "--porcelain=1" => porcelain = true,
            "-z" => z = true,
            "-b" | "--branch" => branch = true,
            "-u" | "-uall" | "--untracked-files" | "--untracked-files=all" => untracked = U::Files,
            "-unormal" | "--untracked-files=normal" => untracked = U::Collapsed,
            "-uno" | "--untracked-files=no" => untracked = U::None,
            "--" => break,
            // combined short flags: -sb, -sz, -sbz
            a if a.len() > 2 && !a.starts_with("--") && a.starts_with('-') && !a.starts_with("-u") => {
                for c in a[1..].chars() {
                    match c {
                        's' => short = true,
                        'b' => branch = true,
                        'z' => z = true,
                        _ => {}
                    }
                }
            }
            a if a.starts_with("--porcelain=") => return crate::fatal(format!("unsupported porcelain version '{}'", &a[12..])),
            _ => {}
        }
    }
    let st = compute_with(ctx, untracked)?;
    if short || porcelain || z {
        // porcelain and -z are plain (no color); the short format quotes odd paths, -z never does
        let paint = |c: &str, s: &str| if porcelain || z { s.to_string() } else { ctx.paint(c, s) };
        let (eol, quote) = if z { ('\0', false) } else { ('\n', true) };
        let mut o = String::new();
        if branch {
            o += &format!("## {}{eol}", branch_header(ctx)?);
        }
        let mut map: BTreeMap<&str, (char, char)> = BTreeMap::new();
        for (p, c) in &st.staged {
            map.entry(p).or_insert((' ', ' ')).0 = *c;
        }
        for (p, c) in &st.unstaged {
            map.entry(p).or_insert((' ', ' ')).1 = *c;
        }
        let q = |p: &str| if quote { quote_path(p, true) } else { p.to_string() };
        for (p, (x, y)) in map {
            let xs = if x == ' ' { " ".into() } else { paint("32", &x.to_string()) };
            let ys = if y == ' ' { " ".into() } else { paint("31", &y.to_string()) };
            o += &format!("{xs}{ys} {}{eol}", q(p));
        }
        for p in &st.untracked {
            o += &format!("{} {}{eol}", paint("31", "??"), q(p));
        }
        crate::out(&o);
        return Ok(0);
    }
    crate::out(&long(ctx, &st)?);
    Ok(0)
}
