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
    for w in worktree_changes(ctx, gix::status::UntrackedFiles::Collapsed)? {
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
            s += &ctx.paint("32", &format!("\t{}{p}", label(*c)));
            s += "\n";
        }
    }
    if !st.unstaged.is_empty() {
        s += "\nChanges not staged for commit:\n";
        s += "  (use \"git add/rm <file>...\" to update what will be committed)\n";
        for (p, c) in &st.unstaged {
            s += &ctx.paint("31", &format!("\t{}{p}", label(*c)));
            s += "\n";
        }
    }
    if !st.untracked.is_empty() {
        s += "\nUntracked files:\n";
        s += "  (use \"git add <file>...\" to include in what will be committed)\n";
        for p in &st.untracked {
            s += &ctx.paint("31", &format!("\t{p}"));
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

pub fn status(ctx: &Ctx, args: &[String]) -> Res {
    let st = compute(ctx)?;
    if args.iter().any(|a| a == "-s" || a == "--short") {
        let mut map: BTreeMap<&str, (char, char)> = BTreeMap::new();
        for (p, c) in &st.staged {
            map.entry(p).or_insert((' ', ' ')).0 = *c;
        }
        for (p, c) in &st.unstaged {
            map.entry(p).or_insert((' ', ' ')).1 = *c;
        }
        for (p, (x, y)) in map {
            let xs = ctx.paint("32", &x.to_string());
            let ys = ctx.paint("31", &y.to_string());
            let xs = if x == ' ' { " ".into() } else { xs };
            let ys = if y == ' ' { " ".into() } else { ys };
            crate::out(&format!("{xs}{ys} {p}\n"));
        }
        for p in &st.untracked {
            crate::out(&format!("{} {p}\n", ctx.paint("31", "??")));
        }
        return Ok(0);
    }
    crate::out(&long(ctx, &st)?);
    Ok(0)
}
