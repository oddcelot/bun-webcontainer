// Unified diffs: git's `diff --git` headers over gix's blob diff (imara-diff).
use crate::status::{Flat, Kind, flat_head, flat_index, load_index, worktree_changes};
use crate::{Ctx, Res, path_str};
use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader};
use gix::diff::blob::{Algorithm, Diff, InternedInput, UnifiedDiff, diff_with_slider_heuristics};

pub struct Side {
    pub mode: u32,
    pub id: ObjectId,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct Stats {
    pub files: usize,
    pub ins: u32,
    pub del: u32,
    /// (old path, new path, similarity %)
    pub renames: Vec<(String, String, u64)>,
}

struct Render<'a> {
    ctx: &'a Ctx,
    out: String,
}

impl ConsumeHunk for Render<'_> {
    type Out = String;

    fn consume_hunk(&mut self, h: HunkHeader, lines: &[(DiffLineKind, &[u8])]) -> std::io::Result<()> {
        let range = |start: u32, len: u32| match len {
            1 => format!("{start}"),
            0 => format!("{},0", start - 1),
            _ => format!("{start},{len}"),
        };
        let head = format!(
            "@@ -{} +{} @@",
            range(h.before_hunk_start, h.before_hunk_len),
            range(h.after_hunk_start, h.after_hunk_len)
        );
        self.out += &self.ctx.paint("36", &head);
        self.out.push('\n');
        for (kind, line) in lines {
            let (prefix, color) = match kind {
                DiffLineKind::Context => (' ', ""),
                DiffLineKind::Add => ('+', "32"),
                DiffLineKind::Remove => ('-', "31"),
            };
            let text = line.to_str_lossy();
            let body = text.strip_suffix('\n').unwrap_or(&text);
            let l = format!("{prefix}{body}");
            self.out += &if color.is_empty() { l } else { self.ctx.paint(color, &l) };
            self.out.push('\n');
            if !text.ends_with('\n') {
                self.out += "\\ No newline at end of file\n";
            }
        }
        Ok(())
    }

    fn finish(self) -> String {
        self.out
    }
}

fn is_binary(d: &[u8]) -> bool {
    d[..d.len().min(8000)].contains(&0)
}

fn abbrev(id: Option<&Side>) -> String {
    id.map_or("0000000".into(), |s| s.id.to_hex_with_len(7).to_string())
}

/// One file's diff, or `None` when nothing differs. `renamed`: the old path and similarity (%) of a rename.
pub fn file_diff(ctx: &Ctx, path: &str, old: Option<&Side>, new: Option<&Side>, st: &mut Stats, renamed: Option<(&str, u64)>) -> Option<String> {
    if let (Some(o), Some(n), None) = (old, new, renamed) {
        if o.id == n.id && o.mode == n.mode {
            return None;
        }
    }
    let bold = |s: &str| ctx.paint("1", s);
    let from = renamed.map_or(path, |r| r.0);
    let mut s = bold(&format!("diff --git a/{from} b/{path}")) + "\n";
    match (old, new) {
        (Some(o), Some(n)) if renamed.is_some() => {
            if o.mode != n.mode {
                s += &bold(&format!("old mode {:o}\nnew mode {:o}", o.mode, n.mode));
                s += "\n";
            }
            let (_, pct) = renamed.expect("a rename");
            s += &bold(&format!("similarity index {pct}%\nrename from {from}\nrename to {path}"));
            s += "\n";
            if o.id != n.id {
                let tail = if o.mode == n.mode { format!(" {:o}", n.mode) } else { String::new() };
                s += &bold(&format!("index {}..{}{tail}", abbrev(Some(o)), abbrev(Some(n))));
                s += "\n";
            }
        }
        (None, Some(n)) => {
            s += &bold(&format!("new file mode {:o}", n.mode));
            s += &format!("\n{}\n", bold(&format!("index {}..{}", abbrev(None), abbrev(Some(n)))));
        }
        (Some(o), None) => {
            s += &bold(&format!("deleted file mode {:o}", o.mode));
            s += &format!("\n{}\n", bold(&format!("index {}..{}", abbrev(Some(o)), abbrev(None))));
        }
        (Some(o), Some(n)) => {
            if o.mode != n.mode {
                s += &bold(&format!("old mode {:o}\nnew mode {:o}", o.mode, n.mode));
                s += "\n";
            }
            let tail = if o.mode == n.mode { format!(" {:o}", n.mode) } else { String::new() };
            s += &bold(&format!("index {}..{}{tail}", abbrev(Some(o)), abbrev(Some(n))));
            s += "\n";
        }
        _ => return None,
    }
    st.files += 1;
    let (old_data, new_data) = (old.map_or(&[][..], |o| &o.data[..]), new.map_or(&[][..], |n| &n.data[..]));
    if old_data == new_data {
        return Some(s);
    }
    if is_binary(old_data) || is_binary(new_data) {
        let a = if old.is_some() { format!("a/{from}") } else { "/dev/null".into() };
        let b = if new.is_some() { format!("b/{path}") } else { "/dev/null".into() };
        s += &format!("Binary files {a} and {b} differ\n");
        return Some(s);
    }
    let a = if old.is_some() { format!("a/{from}") } else { "/dev/null".into() };
    let b = if new.is_some() { format!("b/{path}") } else { "/dev/null".into() };
    s += &bold(&format!("--- {a}"));
    s += "\n";
    s += &bold(&format!("+++ {b}"));
    s += "\n";
    let input = InternedInput::new(old_data, new_data);
    let diff: Diff = diff_with_slider_heuristics(Algorithm::Histogram, &input);
    st.ins += diff.count_additions();
    st.del += diff.count_removals();
    let body = UnifiedDiff::new(&diff, &input, Render { ctx, out: String::new() }, ContextSize::symmetrical(3))
        .consume()
        .unwrap_or_default();
    s += &body;
    Some(s)
}

fn object_side(ctx: &Ctx, e: &(u32, ObjectId)) -> Result<Side, crate::Exit> {
    let data = if e.0 == 0o160000 { Vec::new() } else { ctx.repo.find_object(e.1)?.detach().data };
    Ok(Side { mode: e.0, id: e.1, data })
}

/// Diff two flat trees/indexes, appending to `out`. Renames are found as git finds them (rename.rs); one shows where
/// its new path sorts.
pub fn diff_flats(ctx: &Ctx, old: &Flat, new: &Flat, out: &mut String, st: &mut Stats) -> Result<(), crate::Exit> {
    let deleted: Vec<_> = old.iter().filter(|(p, _)| !new.contains_key(*p)).map(|(p, e)| (p.clone(), *e)).collect();
    let added: Vec<_> = new.iter().filter(|(p, _)| !old.contains_key(*p)).map(|(p, e)| (p.clone(), *e)).collect();
    let renames = crate::rename::detect(ctx, &deleted, &added)?;
    let from: std::collections::HashMap<&BString, &crate::rename::Rename> = renames.iter().map(|r| (&r.new, r)).collect();
    let sources: std::collections::HashSet<&BString> = renames.iter().map(|r| &r.old).collect();
    let mut paths: Vec<&BString> = old.keys().chain(new.keys()).filter(|p| !sources.contains(p)).collect();
    paths.sort();
    paths.dedup();
    for p in paths {
        let rename = from.get(p);
        let (o, n) = (rename.map_or(old.get(p), |r| old.get(&r.old)), new.get(p));
        if o == n && rename.is_none() {
            continue;
        }
        let (os, ns) = (o.map(|e| object_side(ctx, e)).transpose()?, n.map(|e| object_side(ctx, e)).transpose()?);
        let renamed = rename.map(|r| (path_str(&r.old), r.percent()));
        if let Some((old_path, pct)) = &renamed {
            st.renames.push((old_path.clone(), path_str(p), *pct));
        }
        if let Some(d) = file_diff(ctx, &path_str(p), os.as_ref(), ns.as_ref(), st, renamed.as_ref().map(|(o, pct)| (o.as_str(), *pct))) {
            out.push_str(&d);
        }
    }
    Ok(())
}

/// git's `--stat` (diff.c show_stats, 80 columns) and, with `summary`, `--summary`: ` a.txt | 2 +-` per file,
/// ` 3 files changed, 2 insertions(+), 2 deletions(-)`, then ` create mode 100644 n.txt` and the like.
pub fn stat(ctx: &Ctx, old: &Flat, new: &Flat, summary: bool) -> Result<String, crate::Exit> {
    struct File {
        name: String,
        add: usize,
        del: usize,
        binary: bool,
    }
    let deleted: Vec<_> = old.iter().filter(|(p, _)| !new.contains_key(*p)).map(|(p, e)| (p.clone(), *e)).collect();
    let added: Vec<_> = new.iter().filter(|(p, _)| !old.contains_key(*p)).map(|(p, e)| (p.clone(), *e)).collect();
    let renames = crate::rename::detect(ctx, &deleted, &added)?;
    let from: std::collections::HashMap<&BString, &crate::rename::Rename> = renames.iter().map(|r| (&r.new, r)).collect();
    let sources: std::collections::HashSet<&BString> = renames.iter().map(|r| &r.old).collect();
    let mut paths: Vec<&BString> = old.keys().chain(new.keys()).filter(|p| !sources.contains(p)).collect();
    paths.sort();
    paths.dedup();
    let (mut files, mut notes) = (Vec::new(), Vec::new());
    for p in paths {
        let rename = from.get(p);
        let (o, n) = (rename.map_or(old.get(p), |r| old.get(&r.old)), new.get(p));
        if o == n && rename.is_none() {
            continue;
        }
        let data = |e: Option<&(u32, ObjectId)>| e.map(|e| object_side(ctx, e).map(|s| s.data)).transpose();
        let (od, nd) = (data(o)?.unwrap_or_default(), data(n)?.unwrap_or_default());
        let name = match rename {
            Some(r) => crate::rename::pprint(&path_str(&r.old), &path_str(p)),
            None => path_str(p),
        };
        let file = if is_binary(&od) || is_binary(&nd) {
            File { name, add: nd.len(), del: od.len(), binary: true }
        } else {
            let input = InternedInput::new(&od[..], &nd[..]);
            let diff: Diff = diff_with_slider_heuristics(Algorithm::Histogram, &input);
            File { name, add: diff.count_additions() as usize, del: diff.count_removals() as usize, binary: false }
        };
        files.push(file);
        match (o, n, rename) {
            (_, _, Some(r)) => notes.push(format!(" rename {} ({}%)\n", crate::rename::pprint(&path_str(&r.old), &path_str(p)), r.percent())),
            (None, Some((m, _)), _) => notes.push(format!(" create mode {m:o} {}\n", path_str(p))),
            (Some((m, _)), None, _) => notes.push(format!(" delete mode {m:o} {}\n", path_str(p))),
            (Some((om, _)), Some((nm, _)), _) if om != nm => notes.push(format!(" mode change {om:o} => {nm:o} {}\n", path_str(p))),
            _ => {}
        }
    }
    let width = 80usize;
    let digits = |n: usize| n.to_string().len();
    let (mut max_change, mut max_len, mut bin_width, mut number_width) = (0usize, 0usize, 0usize, 0usize);
    for f in &files {
        max_len = max_len.max(f.name.chars().count());
        if f.binary {
            bin_width = bin_width.max(14 + digits(f.add) + digits(f.del));
            number_width = 3;
        } else {
            max_change = max_change.max(f.add + f.del);
        }
    }
    number_width = number_width.max(digits(max_change));
    let width = width.max(16 + 6 + number_width);
    let mut graph_width = if max_change + 4 > bin_width { max_change } else { bin_width - 4 };
    let mut name_width = max_len;
    if name_width + number_width + 6 + graph_width > width {
        let limit = (width * 3 / 8).saturating_sub(number_width + 6);
        if graph_width > limit {
            graph_width = limit.max(6);
        }
        if name_width > width - number_width - 6 - graph_width {
            name_width = width - number_width - 6 - graph_width;
        } else {
            graph_width = width - number_width - 6 - name_width;
        }
    }
    let scale = |it: usize| if it == 0 { 0 } else { 1 + it * (graph_width - 1) / max_change };
    let mut s = String::new();
    let (mut ins, mut del) = (0, 0);
    for f in &files {
        let (mut prefix, mut name) = ("", f.name.as_str());
        let mut len = name_width;
        if name_width < name.chars().count() {
            prefix = "...";
            len = len.saturating_sub(3);
            let skip = name.chars().count() - len;
            name = &name[name.char_indices().nth(skip).map_or(name.len(), |(i, _)| i)..];
            if let Some(i) = name.find('/') {
                name = &name[i..];
            }
        }
        let pad = " ".repeat(len.saturating_sub(name.chars().count()));
        if f.binary {
            s += &format!(" {prefix}{name}{pad} | {:>number_width$}", "Bin");
            if f.add == 0 && f.del == 0 {
                s += "\n";
            } else {
                s += &format!(" {} -> {} bytes\n", ctx.paint("31", &f.del.to_string()), ctx.paint("32", &f.add.to_string()));
            }
            continue;
        }
        ins += f.add;
        del += f.del;
        let (mut a, mut d) = (f.add, f.del);
        if graph_width <= max_change {
            let mut total = scale(a + d);
            if total < 2 && a > 0 && d > 0 {
                total = 2;
            }
            if a < d {
                a = scale(a);
                d = total - a;
            } else {
                d = scale(d);
                a = total - d;
            }
        }
        let n = f.add + f.del;
        s += &format!(" {prefix}{name}{pad} | {n:>number_width$}{}", if n > 0 { " " } else { "" });
        if a > 0 {
            s += &ctx.paint("32", &"+".repeat(a));
        }
        if d > 0 {
            s += &ctx.paint("31", &"-".repeat(d));
        }
        s += "\n";
    }
    s += &stat_summary(files.len(), ins, del);
    if summary {
        s += &notes.concat();
    }
    Ok(s)
}

/// ` 2 files changed, 3 insertions(+), 1 deletion(-)` (diff.c print_stat_summary).
pub fn stat_summary(files: usize, ins: usize, del: usize) -> String {
    if files == 0 {
        return " 0 files changed\n".into();
    }
    let n = |v: usize, one: &str, many: &str| format!("{v} {}", if v == 1 { one } else { many });
    let mut s = format!(" {}", n(files, "file changed", "files changed"));
    if ins > 0 || del == 0 {
        s += &format!(", {}", n(ins, "insertion(+)", "insertions(+)"));
    }
    if del > 0 || ins == 0 {
        s += &format!(", {}", n(del, "deletion(-)", "deletions(-)"));
    }
    s + "\n"
}

pub fn diff(ctx: &Ctx, args: &[String]) -> Res {
    let (mut out, mut st) = (String::new(), Stats::default());
    if args.iter().any(|a| a == "--cached" || a == "--staged") {
        let index = load_index(ctx)?;
        diff_flats(ctx, &flat_head(ctx)?, &flat_index(&index), &mut out, &mut st)?;
    } else {
        for w in worktree_changes(ctx, gix::status::UntrackedFiles::None)? {
            let Some(entry) = w.entry.filter(|_| w.kind != Kind::Untracked) else { continue };
            let old = object_side(ctx, &entry)?;
            let new = if w.kind == Kind::Deleted {
                None
            } else {
                let p = std::path::Path::new("/").join(w.path.to_str_lossy().as_ref());
                let data = std::fs::read(p)?;
                let id = gix::objs::compute_hash(ctx.repo.object_hash(), gix::object::Kind::Blob, &data)?;
                Some(Side { mode: entry.0, id, data })
            };
            if let Some(d) = file_diff(ctx, &path_str(&w.path), Some(&old), new.as_ref(), &mut st, None) {
                out.push_str(&d);
            }
        }
    }
    crate::out(&out);
    Ok(0)
}
