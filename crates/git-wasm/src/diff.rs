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

/// One file's diff, or `None` when nothing differs.
pub fn file_diff(ctx: &Ctx, path: &str, old: Option<&Side>, new: Option<&Side>, st: &mut Stats) -> Option<String> {
    if let (Some(o), Some(n)) = (old, new) {
        if o.id == n.id && o.mode == n.mode {
            return None;
        }
    }
    let bold = |s: &str| ctx.paint("1", s);
    let mut s = bold(&format!("diff --git a/{path} b/{path}")) + "\n";
    match (old, new) {
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
        let a = if old.is_some() { format!("a/{path}") } else { "/dev/null".into() };
        let b = if new.is_some() { format!("b/{path}") } else { "/dev/null".into() };
        s += &format!("Binary files {a} and {b} differ\n");
        return Some(s);
    }
    let a = if old.is_some() { format!("a/{path}") } else { "/dev/null".into() };
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

/// Diff two flat trees/indexes, appending to `out`.
pub fn diff_flats(ctx: &Ctx, old: &Flat, new: &Flat, out: &mut String, st: &mut Stats) -> Result<(), crate::Exit> {
    let mut paths: Vec<&BString> = old.keys().chain(new.keys()).collect();
    paths.sort();
    paths.dedup();
    for p in paths {
        let (o, n) = (old.get(p), new.get(p));
        if o == n {
            continue;
        }
        let (os, ns) = (o.map(|e| object_side(ctx, e)).transpose()?, n.map(|e| object_side(ctx, e)).transpose()?);
        if let Some(d) = file_diff(ctx, &path_str(p), os.as_ref(), ns.as_ref(), st) {
            out.push_str(&d);
        }
    }
    Ok(())
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
            if let Some(d) = file_diff(ctx, &path_str(&w.path), Some(&old), new.as_ref(), &mut st) {
                out.push_str(&d);
            }
        }
    }
    crate::out(&out);
    Ok(0)
}
