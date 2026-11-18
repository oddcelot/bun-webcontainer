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
    /// paths with conflict stages, and which of them they have (bit 0: base, 1: ours, 2: theirs)
    pub unmerged: Vec<(String, u8)>,
    /// (path, 'A' | 'M' | 'D' | 'T' | 'R'); a rename under its new path
    pub staged: Vec<(String, char)>,
    /// new path -> old path, for the staged renames
    pub renamed_from: BTreeMap<String, String>,
    pub unstaged: Vec<(String, char)>,
    pub untracked: Vec<String>,
}

pub fn compute(ctx: &Ctx) -> Result<Status, crate::Exit> {
    compute_with(ctx, gix::status::UntrackedFiles::Collapsed)
}

pub fn compute_with(ctx: &Ctx, mode: gix::status::UntrackedFiles) -> Result<Status, crate::Exit> {
    let index = load_index(ctx)?;
    let (head, idx) = (flat_head(ctx)?, flat_index(&index));
    let conflicts = unmerged(&index);
    let mut staged = Vec::new();
    for (p, (m, id)) in &idx {
        if conflicts.contains_key(p) {
            continue;
        }
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
        if !idx.contains_key(p) && !conflicts.contains_key(p) {
            staged.push((path_str(p), 'D'));
        }
    }
    // A deleted and an added file that git pairs up are one rename.
    let side = |flat: &Flat, p: &str| (BString::from(p), flat[&BString::from(p)]);
    let deleted: Vec<_> = staged.iter().filter(|(_, c)| *c == 'D').map(|(p, _)| side(&head, p)).collect();
    let mut added: Vec<_> = staged.iter().filter(|(_, c)| *c == 'A').map(|(p, _)| side(&idx, p)).collect();
    added.sort();
    let mut renamed_from = BTreeMap::new();
    for r in crate::rename::detect(ctx, &{ let mut d = deleted; d.sort(); d }, &added)? {
        let (old, new) = (path_str(&r.old), path_str(&r.new));
        staged.retain(|(p, c)| !(*p == old && *c == 'D'));
        if let Some(e) = staged.iter_mut().find(|(p, _)| *p == new) {
            e.1 = 'R';
        }
        renamed_from.insert(new, old);
    }
    staged.sort();
    let (mut unstaged, mut untracked) = (Vec::new(), Vec::new());
    for w in worktree_changes(ctx, mode)? {
        let p = path_str(&w.path);
        if conflicts.contains_key(&w.path) {
            continue;
        }
        match w.kind {
            Kind::Modified => unstaged.push((p, 'M')),
            Kind::Deleted => unstaged.push((p, 'D')),
            Kind::Untracked => untracked.push(if w.is_dir { format!("{p}/") } else { p }),
        }
    }
    let unmerged = conflicts.into_iter().map(|(p, m)| (path_str(&p), m)).collect();
    Ok(Status { unmerged, staged, renamed_from, unstaged, untracked })
}

/// Paths with conflict stages (1 base, 2 ours, 3 theirs) and which stages each has, as a mask (bit `stage - 1`).
pub fn unmerged(index: &gix::index::State) -> BTreeMap<BString, u8> {
    let mut map = BTreeMap::new();
    for e in index.entries().iter().filter(|e| e.stage_raw() > 0) {
        *map.entry(e.path(index).to_owned()).or_insert(0) |= 1 << (e.stage_raw() - 1);
    }
    map
}

/// A merge is in progress (`.git/MERGE_HEAD`).
pub fn merging() -> bool {
    std::path::Path::new("/.git/MERGE_HEAD").exists()
}

/// The short format's code for a conflict's stage mask (wt-status.c).
pub fn unmerged_code(mask: u8) -> &'static str {
    match mask {
        1 => "DD",
        2 => "AU",
        3 => "UD",
        4 => "UA",
        5 => "DU",
        6 => "AA",
        _ => "UU",
    }
}

fn unmerged_label(mask: u8) -> &'static str {
    match mask {
        1 => "both deleted:",
        2 => "added by us:",
        3 => "deleted by them:",
        4 => "added by them:",
        5 => "deleted by us:",
        6 => "both added:",
        _ => "both modified:",
    }
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
        'R' => "renamed:    ",
        _ => "modified:   ",
    }
}

/// `HEAD detached at|from <what>` (wt-status.c's wt_status_get_detached_from): the target of HEAD's last `checkout:
/// moving from A to B` reflog entry, named as the ref it is if that still points where HEAD went then, else as that
/// commit; `at` while HEAD is still there.
fn detached_line(ctx: &Ctx) -> String {
    let head = ctx.repo.head_id().ok().map(|i| i.detach());
    let log = std::fs::read_to_string("/.git/logs/HEAD").unwrap_or_default();
    let entry = log.lines().rev().find_map(|l| {
        let (meta, msg) = l.split_once('\t')?;
        let target = msg.strip_prefix("checkout: moving from ")?.split_once(" to ")?.1;
        let new = ObjectId::from_hex(meta.split(' ').nth(1)?.as_bytes()).ok()?;
        Some((target.to_string(), new))
    });
    let Some((target, new)) = entry else {
        return format!("HEAD detached at {}\n", head.map(crate::history::short).unwrap_or_default());
    };
    let peeled = |r: &str| ctx.repo.find_reference(r).ok().and_then(|r| r.into_fully_peeled_id().ok()).map(|i| i.detach());
    let rules = [target.clone(), format!("refs/{target}"), format!("refs/tags/{target}"), format!("refs/heads/{target}"), format!("refs/remotes/{target}"), format!("refs/remotes/{target}/HEAD")];
    let found: Vec<&String> = if target == "HEAD" { Vec::new() } else { rules.iter().filter(|r| r.starts_with("refs/") && ctx.repo.find_reference(r.as_str()).is_ok()).collect() };
    let from = match found.as_slice() {
        [r] if peeled(r) == Some(new) => r.strip_prefix("refs/tags/").or_else(|| r.strip_prefix("refs/remotes/")).unwrap_or(r).to_string(),
        _ => crate::history::short(new),
    };
    format!("HEAD detached {} {from}\n", if head == Some(new) { "at" } else { "from" })
}

/// The long format, ending in git's closing hint. Returns whether there is anything staged.
pub fn long(ctx: &Ctx, st: &Status) -> Result<String, crate::Exit> {
    let mut s = String::new();
    let branch = ctx.repo.head_name()?;
    match (&branch, crate::rebase::status_header()) {
        (None, Some(header)) => {
            s += &header;
            s += &crate::rebase::status_lines(!st.unmerged.is_empty());
        }
        (Some(n), _) => s += &format!("On branch {}\n", n.shorten().to_str_lossy()),
        (None, None) => s += &detached_line(ctx),
    }
    let unborn = ctx.repo.head_id().is_err();
    if unborn {
        s += "\nNo commits yet\n\n";
    }
    let merging = merging();
    if merging {
        s += if st.unmerged.is_empty() {
            "All conflicts fixed but you are still merging.\n  (use \"git commit\" to conclude merge)\n\n"
        } else {
            "You have unmerged paths.\n  (fix conflicts and run \"git commit\")\n  (use \"git merge --abort\" to abort the merge)\n\n"
        };
    }
    if !st.staged.is_empty() {
        s += "Changes to be committed:\n";
        // git's hints (wt-status.c); none while merging
        s += match () {
            _ if merging => "",
            _ if unborn => "  (use \"git rm --cached <file>...\" to unstage)\n",
            _ => "  (use \"git restore --staged <file>...\" to unstage)\n",
        };
        for (p, c) in &st.staged {
            let p = match st.renamed_from.get(p) {
                Some(old) => format!("{} -> {}", quote_path(old, false), quote_path(p, false)),
                None => quote_path(p, false),
            };
            s += &ctx.paint("32", &format!("\t{}{p}", label(*c)));
            s += "\n";
        }
        s += "\n";
    }
    if !st.unmerged.is_empty() {
        s += "Unmerged paths:\n";
        if !merging && !unborn {
            s += "  (use \"git restore --staged <file>...\" to unstage)\n";
        }
        let both_deleted = st.unmerged.iter().any(|(_, m)| *m == 1);
        let del_mod = st.unmerged.iter().any(|(_, m)| *m == 3 || *m == 5);
        let not_deleted = st.unmerged.iter().any(|(_, m)| ![1, 3, 5].contains(m));
        s += match () {
            _ if !both_deleted && !del_mod => "  (use \"git add <file>...\" to mark resolution)\n",
            _ if both_deleted && !del_mod && !not_deleted => "  (use \"git rm <file>...\" to mark resolution)\n",
            _ => "  (use \"git add/rm <file>...\" as appropriate to mark resolution)\n",
        };
        for (p, m) in &st.unmerged {
            s += &ctx.paint("31", &format!("\t{:<17}{}", unmerged_label(*m), quote_path(p, false)));
            s += "\n";
        }
        s += "\n";
    }
    if !st.unstaged.is_empty() {
        s += "Changes not staged for commit:\n";
        let rm = if st.unstaged.iter().any(|(_, c)| *c == 'D') { "/rm" } else { "" };
        s += &format!("  (use \"git add{rm} <file>...\" to update what will be committed)\n");
        s += "  (use \"git restore <file>...\" to discard changes in working directory)\n";
        for (p, c) in &st.unstaged {
            s += &ctx.paint("31", &format!("\t{}{}", label(*c), quote_path(p, false)));
            s += "\n";
        }
        s += "\n";
    }
    if !st.untracked.is_empty() {
        s += "Untracked files:\n";
        s += "  (use \"git add <file>...\" to include in what will be committed)\n";
        for p in &st.untracked {
            s += &ctx.paint("31", &format!("\t{}", quote_path(p, false)));
            s += "\n";
        }
        s += "\n";
    }
    // Each section ends in a blank line; with something staged, git prints nothing more.
    s += match () {
        _ if !st.staged.is_empty() => "",
        _ if !st.unstaged.is_empty() || !st.unmerged.is_empty() => "no changes added to commit (use \"git add\" and/or \"git commit -a\")\n",
        _ if !st.untracked.is_empty() => "nothing added to commit but untracked files present (use \"git add\" to track)\n",
        _ if unborn => "nothing to commit (create/copy files and use \"git add\" to track)\n",
        _ => "nothing to commit, working tree clean\n",
    };
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

/// `## main`, `## main...origin/main [ahead 1, behind 2]`, `## main...origin/main [gone]`, `## No commits yet on main`,
/// `## HEAD (no branch)`.
fn branch_header(ctx: &Ctx) -> Result<String, crate::Exit> {
    Ok(match ctx.repo.head_name()? {
        Some(n) => {
            let n = n.shorten().to_str_lossy().into_owned();
            match ctx.repo.head_id() {
                Err(_) => format!("No commits yet on {n}"),
                Ok(head) => match upstream(ctx, &n) {
                    Some((short, full)) => format!("{n}...{short}{}", ahead_behind(ctx, head.detach(), &full)),
                    None => n,
                },
            }
        }
        None => "HEAD (no branch)".into(),
    })
}

/// The branch's upstream from `branch.<b>.remote` and `.merge`: its short name (`origin/main`) and full ref.
pub fn upstream(ctx: &Ctx, branch: &str) -> Option<(String, String)> {
    let config = ctx.repo.config_snapshot();
    let remote = config.string(format!("branch.{branch}.remote").as_str())?.to_string();
    let merge = config.string(format!("branch.{branch}.merge").as_str())?.to_string();
    let name = merge.strip_prefix("refs/heads/")?;
    Some(if remote == "." { (name.to_string(), merge.clone()) } else { (format!("{remote}/{name}"), format!("refs/remotes/{remote}/{name}")) })
}

/// ` [ahead 1, behind 2]`, ` [gone]` when the upstream's ref is missing, or nothing when the two are the same commit.
fn ahead_behind(ctx: &Ctx, head: ObjectId, upstream: &str) -> String {
    let Some(theirs) = ctx.repo.find_reference(upstream).ok().and_then(|mut r| r.peel_to_id().ok()).map(|id| id.detach()) else {
        return " [gone]".into();
    };
    let count = |from: ObjectId, hide: ObjectId| ctx.repo.rev_walk([from]).with_hidden([hide]).all().map(|w| w.filter(|i| i.is_ok()).count()).unwrap_or(0);
    let (ahead, behind) = (count(head, theirs), count(theirs, head));
    match (ahead, behind) {
        (0, 0) => String::new(),
        (a, 0) => format!(" [ahead {a}]"),
        (0, b) => format!(" [behind {b}]"),
        (a, b) => format!(" [ahead {a}, behind {b}]"),
    }
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
        // conflicts sort in with the rest: `UU path`
        let mut map: BTreeMap<&str, Option<(char, char)>> = map.into_iter().map(|(p, e)| (p, Some(e))).collect();
        for (p, _) in &st.unmerged {
            map.insert(p, None);
        }
        let masks: BTreeMap<&str, u8> = st.unmerged.iter().map(|(p, m)| (p.as_str(), *m)).collect();
        for (p, e) in map {
            let Some((x, y)) = e else {
                o += &format!("{} {}{eol}", paint("31", unmerged_code(masks[p])), q(p));
                continue;
            };
            let xs = if x == ' ' { " ".into() } else { paint("32", &x.to_string()) };
            let ys = if y == ' ' { " ".into() } else { paint("31", &y.to_string()) };
            // A rename: `R  old -> new`, or with -z the new path, then the old one.
            match st.renamed_from.get(p) {
                Some(old) if z => o += &format!("{xs}{ys} {p}\0{old}\0"),
                Some(old) => o += &format!("{xs}{ys} {} -> {}{eol}", q(old), q(p)),
                None => o += &format!("{xs}{ys} {}{eol}", q(p)),
            }
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
