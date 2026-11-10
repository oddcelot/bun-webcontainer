// Probe (bwc-vm5): what gix can do over a WASI filesystem. Runs in $PROBE_ROOT (default /repo, preopened by run.ts):
// init, commit two revisions, write the index, change the worktree, then report status, the tree diff and the log.
use gix::bstr::BString;
use gix::objs::tree::EntryKind;
use std::fs;

type R<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn root() -> String {
    std::env::var("PROBE_ROOT").unwrap_or_else(|_| "/repo".into())
}

fn sig() -> gix::actor::Signature {
    gix::actor::Signature {
        name: "Probe".into(),
        email: "probe@example.com".into(),
        time: gix::date::Time::new(1_700_000_000, 0),
    }
}

fn commit(repo: &gix::Repository, files: &[(&str, &str)], msg: &str) -> R<gix::ObjectId> {
    let base = repo.head_tree_id().map(|id| id.detach()).unwrap_or(repo.empty_tree().id);
    let mut editor = repo.edit_tree(base)?;
    for (path, text) in files {
        fs::write(format!("{}/{path}", root()), text)?;
        let blob = repo.write_blob(text.as_bytes())?;
        editor.upsert(*path, EntryKind::Blob, blob)?;
    }
    let tree = editor.write()?;
    let parents: Vec<gix::ObjectId> = repo.head_id().ok().map(|id| id.detach()).into_iter().collect();
    let s = sig();
    let (mut b1, mut b2) = (gix::date::parse::TimeBuf::default(), gix::date::parse::TimeBuf::default());
    let id = repo.commit_as(s.to_ref(&mut b1), s.to_ref(&mut b2), "HEAD", msg, tree, parents)?;
    let mut index = repo.index_from_tree(&tree)?;
    index.write(Default::default())?;
    Ok(id.detach())
}

/// PROBE_OPEN: read an existing (packed) repo instead: count the log, run status.
fn open_existing(root: &str) -> R<()> {
    let repo = gix::open(root)?;
    let head = repo.head_commit()?;
    let n = head.ancestors().all()?.count();
    println!("open: HEAD {} {:?}, {n} commits", head.id, head.message()?.summary());
    let tree = head.tree()?;
    let mut files = 0;
    tree.traverse().breadthfirst(&mut gix::traverse::tree::Recorder::default()).map(|_| ())?;
    let mut rec = gix::traverse::tree::Recorder::default();
    tree.traverse().breadthfirst(&mut rec)?;
    files += rec.records.iter().filter(|e| e.mode.is_blob()).count();
    println!("open: {files} files in HEAD's tree");
    let mut changed = 0;
    for item in repo.status(gix::progress::Discard)?.into_index_worktree_iter(Vec::<BString>::new())? {
        let item = item?;
        if changed < 3 {
            println!("open: change {} {:?}", item.rela_path(), item.summary());
        }
        changed += 1;
    }
    println!("open: status, {changed} changes");
    Ok(())
}

fn main() -> R<()> {
    let root = root();
    if std::env::var("PROBE_OPEN").is_ok() {
        return open_existing(&root);
    }
    let repo = gix::init(&root)?;
    println!("init: {:?}", repo.git_dir());
    let c1 = commit(&repo, &[("index.ts", "console.log(1)\n"), ("README.md", "# probe\n")], "first")?;
    let repo = gix::open(&root)?; // reopen so the index is read fresh
    let c2 = commit(&repo, &[("index.ts", "console.log(2)\n")], "second")?;
    println!("commits: {c1} {c2}");

    // Worktree changes: modify a tracked file, add an untracked one.
    let repo = gix::open(&root)?;
    fs::write(format!("{root}/README.md"), "# probe, edited\n")?;
    fs::write(format!("{root}/new.ts"), "export {}\n")?;

    let status = repo.status(gix::progress::Discard)?.untracked_files(if std::env::var("PROBE_NO_UNTRACKED").is_ok() { gix::status::UntrackedFiles::None } else { gix::status::UntrackedFiles::Files });
    for item in status.into_index_worktree_iter(Vec::<BString>::new())? {
        let item = item?;
        println!("status: {} {:?}", item.rela_path(), item.summary());
    }

    let t1 = repo.find_commit(c1)?.tree()?;
    let t2 = repo.find_commit(c2)?.tree()?;
    for change in repo.diff_tree_to_tree(Some(&t1), Some(&t2), None)? {
        use gix::object::tree::diff::ChangeDetached as C;
        let kind = match change {
            C::Addition { .. } => "added",
            C::Deletion { .. } => "deleted",
            C::Modification { .. } => "modified",
            C::Rewrite { .. } => "rewritten",
        };
        println!("diff c1..c2: {kind} {}", change.location());
    }

    for info in repo.head_commit()?.ancestors().all()? {
        let info = info?;
        println!("log: {} {}", info.id, info.object()?.message()?.summary());
    }
    Ok(())
}
