// `git push` by hand: gix has no receive-pack client. Smart HTTP, protocol v0 (receive-pack has no v2):
//   GET  <url>/info/refs?service=git-receive-pack   the remote's refs and capabilities
//   POST <url>/git-receive-pack                      "<old> <new> <ref>" commands, then a pack of what the remote lacks
// The pack holds whole objects (no deltas): the commits the remote doesn't have, and their trees and blobs but those
// already in the trees of the commits they build on. Bigger than git's, but simple, and the server indexes it as any.
use crate::net::{host_of, remote_name};
use crate::{Ctx, Exit, Res, error, fatal, out, positional};
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::refs::transaction::PreviousValue;
use std::collections::{HashMap, HashSet};
use std::io::Write;

fn pkt(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(format!("{:04x}", data.len() + 4).as_bytes());
    out.extend_from_slice(data);
}

/// pkt-lines up to the first flush (`None` for a flush), and what follows it.
fn pkt_lines(mut data: &[u8]) -> Result<(Vec<&[u8]>, &[u8]), Exit> {
    let mut lines = Vec::new();
    while data.len() >= 4 {
        let n = std::str::from_utf8(&data[..4]).ok().and_then(|h| usize::from_str_radix(h, 16).ok());
        let Some(n) = n else { return fatal("protocol error: bad pkt-line from the remote") };
        if n == 0 {
            return Ok((lines, &data[4..]));
        }
        if n < 4 || n > data.len() {
            return fatal("protocol error: bad pkt-line length from the remote");
        }
        lines.push(&data[4..n]);
        data = &data[n..];
    }
    Ok((lines, data))
}

struct Advertised {
    refs: HashMap<String, ObjectId>,
    caps: HashSet<String>,
}

fn advertisement(body: &[u8]) -> Result<Advertised, Exit> {
    let (head, rest) = pkt_lines(body)?;
    // Smart HTTP starts with "# service=git-receive-pack" and a flush; a dumb server sends a plain ref list.
    if !head.first().is_some_and(|l| l.starts_with(b"# service=git-receive-pack")) {
        return fatal("the remote doesn't speak git's smart HTTP for push");
    }
    let (lines, _) = pkt_lines(rest)?;
    let mut refs = HashMap::new();
    let mut caps = HashSet::new();
    for (i, line) in lines.iter().enumerate() {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let (line, cap) = match line.find_byte(0) {
            Some(z) => (&line[..z], Some(&line[z + 1..])),
            None => (line, None),
        };
        if i == 0
            && let Some(cap) = cap
        {
            caps = cap.to_str_lossy().split(' ').filter(|c| !c.is_empty()).map(str::to_string).collect();
        }
        let Some((id, name)) = line.to_str().ok().and_then(|l| l.split_once(' ')) else { continue };
        // An empty repository advertises "<zero> capabilities^{}".
        if name == "capabilities^{}" {
            continue;
        }
        if let Ok(id) = ObjectId::from_hex(id.as_bytes()) {
            refs.insert(name.to_string(), id);
        }
    }
    Ok(Advertised { refs, caps })
}

/// One ref to update: `src` (None: delete) onto `dst`.
struct Update {
    src: Option<ObjectId>,
    dst: String,
    force: bool,
    /// The local branch it came from, for `-u`.
    branch: Option<String>,
}

enum Verdict {
    UpToDate,
    New,
    FastForward(ObjectId),
    Forced(ObjectId),
    Delete(ObjectId),
    /// Not a fast-forward; `fetch first` when we don't even have the remote's commit.
    Rejected(&'static str),
    DeleteMissing,
}

fn short(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")).unwrap_or(name)
}

fn is_ancestor(repo: &gix::Repository, old: ObjectId, new: ObjectId) -> bool {
    old == new || repo.rev_walk([new]).all().is_ok_and(|w| w.filter_map(Result::ok).any(|i| i.id == old))
}

fn judge(repo: &gix::Repository, u: &Update, remote: Option<ObjectId>) -> Verdict {
    match (u.src, remote) {
        (None, None) => Verdict::DeleteMissing,
        (None, Some(old)) => Verdict::Delete(old),
        (Some(_), None) => Verdict::New,
        (Some(new), Some(old)) if new == old => Verdict::UpToDate,
        (Some(new), Some(old)) => {
            let have = repo.find_object(old).is_ok();
            if have && is_ancestor(repo, old, new) {
                Verdict::FastForward(old)
            } else if u.force {
                Verdict::Forced(old)
            } else if have {
                Verdict::Rejected("non-fast-forward")
            } else {
                Verdict::Rejected("fetch first")
            }
        }
    }
}

/// A local ref or revision for a refspec's source: the branch it names (if it does) and its commit.
fn resolve_src(ctx: &Ctx, src: &str) -> Result<(ObjectId, Option<String>), Exit> {
    for full in [format!("refs/heads/{src}"), src.to_string()] {
        if full.starts_with("refs/heads/")
            && let Ok(Some(mut r)) = ctx.repo.try_find_reference(full.as_str())
        {
            let id = r.peel_to_id()?.detach();
            return Ok((id, Some(full.trim_start_matches("refs/heads/").to_string())));
        }
    }
    match ctx.repo.rev_parse_single(src) {
        Ok(id) => Ok((id.detach(), None)),
        Err(_) => error(format!("src refspec {src} does not match any")),
    }
}

/// `dst` as a full ref name: as given under refs/, else the remote's tag or branch of that name.
fn full_dst(dst: &str, remote: &Advertised) -> String {
    if dst.starts_with("refs/") {
        dst.to_string()
    } else if remote.refs.contains_key(&format!("refs/tags/{dst}")) {
        format!("refs/tags/{dst}")
    } else {
        format!("refs/heads/{dst}")
    }
}

fn updates(ctx: &Ctx, specs: &[String], remote_name: &str, remote: &Advertised, force: bool, delete: bool) -> Result<Vec<Update>, Exit> {
    if specs.is_empty() {
        if delete {
            return fatal("--delete doesn't make sense without any refs");
        }
        // The current branch, to its upstream on this remote, else to the branch of the same name.
        let Some(branch) = ctx.repo.head_name().ok().flatten().map(|n| n.shorten().to_string()) else {
            return fatal("You are not currently on a branch.");
        };
        let snapshot = ctx.repo.config_snapshot();
        let upstream_remote = snapshot.string(format!("branch.{branch}.remote").as_str()).map(|s| s.to_string());
        let merge = snapshot.string(format!("branch.{branch}.merge").as_str()).map(|s| s.to_string());
        let dst = match (upstream_remote, merge) {
            (Some(r), Some(m)) if r == remote_name => m,
            _ => format!("refs/heads/{branch}"),
        };
        let Ok(id) = ctx.repo.head_id() else {
            return error(format!("src refspec {branch} does not match any"));
        };
        return Ok(vec![Update { src: Some(id.detach()), dst, force, branch: Some(branch) }]);
    }
    let mut list = Vec::new();
    for spec in specs {
        if delete {
            list.push(Update { src: None, dst: full_dst(spec, remote), force, branch: None });
            continue;
        }
        let (plus, spec) = match spec.strip_prefix('+') {
            Some(s) => (true, s),
            None => (false, spec.as_str()),
        };
        let (src, dst) = match spec.split_once(':') {
            Some((s, d)) => (s, Some(d)),
            None => (spec, None),
        };
        if src.is_empty() {
            let Some(dst) = dst.filter(|d| !d.is_empty()) else { return fatal(format!("invalid refspec '{spec}'")) };
            list.push(Update { src: None, dst: full_dst(dst, remote), force, branch: None });
            continue;
        }
        let (id, branch) = resolve_src(ctx, src)?;
        let dst = match (dst, &branch) {
            (Some(d), _) if !d.is_empty() => full_dst(d, remote),
            (_, Some(b)) => format!("refs/heads/{b}"),
            _ => {
                return error(format!(
                    "The destination you provided is not a full refname (i.e., starting with \"refs/\"). Try '{src}:refs/heads/<name>'."
                ));
            }
        };
        list.push(Update { src: Some(id), dst, force: force || plus, branch });
    }
    Ok(list)
}

// ---- the pack ----------------------------------------------------------------------------------------------------

/// Every tree and blob below `tree` but those in `skip`, into `into` (each once).
fn collect_tree(repo: &gix::Repository, tree: ObjectId, skip: &HashSet<ObjectId>, into: &mut Vec<ObjectId>, seen: &mut HashSet<ObjectId>) -> Result<(), Exit> {
    if skip.contains(&tree) || !seen.insert(tree) {
        return Ok(());
    }
    into.push(tree);
    let t = repo.find_tree(tree)?;
    for e in t.decode()?.entries.iter() {
        let id = e.oid.to_owned();
        if e.mode.is_commit() {
            continue; // a submodule's commit lives elsewhere
        }
        if e.mode.is_tree() {
            collect_tree(repo, id, skip, into, seen)?;
        } else if !skip.contains(&id) && seen.insert(id) {
            into.push(id);
        }
    }
    Ok(())
}

/// The objects to send: commits reachable from `tips` but not from `remote_has`, with what they bring.
fn objects(repo: &gix::Repository, tips: &[ObjectId], remote_has: &[ObjectId]) -> Result<Vec<ObjectId>, Exit> {
    let hidden: Vec<ObjectId> = remote_has.iter().copied().filter(|id| repo.find_commit(*id).is_ok()).collect();
    let mut commits = Vec::new();
    for info in repo.rev_walk(tips.iter().copied()).with_hidden(hidden.iter().copied()).all()? {
        commits.push(info?.id);
    }
    let sending: HashSet<ObjectId> = commits.iter().copied().collect();
    // What the remote has already: the trees of the commits ours build on (the edge), and of its tips.
    let mut known = HashSet::new();
    let mut scratch = Vec::new();
    let mut edge: Vec<ObjectId> = hidden.clone();
    for id in &commits {
        for p in repo.find_commit(*id)?.parent_ids() {
            if !sending.contains(&p.detach()) {
                edge.push(p.detach());
            }
        }
    }
    let mut done = HashSet::new();
    for id in edge {
        if done.insert(id)
            && let Ok(c) = repo.find_commit(id)
        {
            collect_tree(repo, c.tree_id()?.detach(), &HashSet::new(), &mut scratch, &mut known)?;
        }
    }
    let mut list = Vec::new();
    let mut seen = HashSet::new();
    for id in commits {
        list.push(id);
        collect_tree(repo, repo.find_commit(id)?.tree_id()?.detach(), &known, &mut list, &mut seen)?;
    }
    Ok(list)
}

/// A version 2 pack of `ids`, whole objects only.
fn pack(repo: &gix::Repository, ids: &[ObjectId]) -> Result<Vec<u8>, Exit> {
    let mut data = Vec::new();
    data.extend_from_slice(b"PACK");
    data.extend_from_slice(&2u32.to_be_bytes());
    data.extend_from_slice(&(ids.len() as u32).to_be_bytes());
    for id in ids {
        let obj = repo.find_object(*id)?;
        let kind: u8 = match obj.kind {
            gix::object::Kind::Commit => 1,
            gix::object::Kind::Tree => 2,
            gix::object::Kind::Blob => 3,
            gix::object::Kind::Tag => 4,
        };
        let mut size = obj.data.len();
        let mut byte = (kind << 4) | (size & 0x0f) as u8;
        size >>= 4;
        while size > 0 {
            data.push(byte | 0x80);
            byte = (size & 0x7f) as u8;
            size >>= 7;
        }
        data.push(byte);
        let mut z = gix::zlib::stream::deflate::Write::new(&mut data, gix::zlib::Compression::DEFAULT);
        z.write_all(&obj.data)?;
        z.flush()?;
    }
    let mut h = gix::hash::hasher(gix::hash::Kind::Sha1);
    h.update(&data);
    let sum = h.try_finalize().map_err(|e| Exit { code: 128, msg: format!("fatal: {e}") })?;
    data.extend_from_slice(sum.as_bytes());
    Ok(data)
}

// ---- the command -------------------------------------------------------------------------------------------------

/// The report-status lines of a receive-pack response, unwrapping side-band-64k (band 2: the remote's messages).
fn report_status(body: &[u8], sideband: bool) -> Result<Vec<String>, Exit> {
    let mut status = Vec::new();
    if sideband {
        let mut rest = body;
        loop {
            let (lines, after) = pkt_lines(rest)?;
            for l in &lines {
                match l.first() {
                    Some(1) => status.extend_from_slice(&l[1..]),
                    Some(2) => {
                        for m in l[1..].to_str_lossy().split_inclusive(['\n', '\r']) {
                            let m = m.trim_end_matches(['\n', '\r']);
                            if !m.is_empty() {
                                eprintln!("remote: {m}");
                            }
                        }
                    }
                    Some(3) => return fatal(format!("remote error: {}", l[1..].to_str_lossy().trim_end())),
                    _ => {}
                }
            }
            if after.is_empty() || after.len() == rest.len() {
                break;
            }
            rest = after;
        }
    } else {
        status = body.to_vec();
    }
    let (lines, _) = pkt_lines(&status)?;
    Ok(lines.iter().map(|l| l.to_str_lossy().trim_end_matches('\n').to_string()).collect())
}

fn line(flag: char, summary: &str, from: &str, to: &str, note: &str) {
    let refs = if from.is_empty() { to.to_string() } else { format!("{from} -> {to}") };
    let note = if note.is_empty() { String::new() } else { format!(" ({note})") };
    eprintln!(" {flag} {summary:<17} {refs}{note}");
}

pub fn push(ctx: &Ctx, args: &[String]) -> Res {
    let has = |f: &[&str]| args.iter().any(|a| f.contains(&a.as_str()));
    let force = has(&["-f", "--force"]);
    let upstream = has(&["-u", "--set-upstream"]);
    let delete = has(&["-d", "--delete"]);
    let dry = has(&["-n", "--dry-run"]);
    if let Some(a) = args.iter().find(|a| a.starts_with('-') && !matches!(a.as_str(), "-f" | "--force" | "-u" | "--set-upstream" | "-d" | "--delete" | "-n" | "--dry-run" | "--")) {
        return error(format!("unknown option '{a}' (git push in the playground: [-f] [-u] [-d] [-n] [<remote> [<refspec>...]])"));
    }
    let pos = positional(args);
    let name = remote_name(ctx, pos.first());
    let Some(url) = ctx.repo.config_snapshot().string(format!("remote.{name}.url").as_str()).map(|s| s.to_string()) else {
        return fatal(format!("'{name}' does not appear to be a git repository"));
    };
    let base = url.trim_end_matches('/');
    crate::http::report(&format!("Connecting to {}", host_of(base)));
    let unreachable = |e: std::io::Error| {
        let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
            "\nhint: Pushing to GitHub needs you signed in with GitHub (the Git view's ⋯ menu), with this repository granted to\nhint: runbun.dev. Other hosts can't be pushed to from the playground."
        } else {
            ""
        };
        Exit { code: 128, msg: format!("fatal: unable to access '{url}': {e}{hint}") }
    };
    let adv = crate::http::request("GET", &format!("{base}/info/refs?service=git-receive-pack"), &[], Vec::new()).map_err(unreachable)?;
    let remote = advertisement(&adv)?;
    let list = updates(ctx, pos.get(1..).unwrap_or_default(), &name, &remote, force, delete)?;

    let verdicts: Vec<Verdict> = list.iter().map(|u| judge(&ctx.repo, u, remote.refs.get(&u.dst).copied())).collect();
    let sending: Vec<(&Update, &Verdict)> =
        list.iter().zip(&verdicts).filter(|(_, v)| matches!(v, Verdict::New | Verdict::FastForward(_) | Verdict::Forced(_) | Verdict::Delete(_))).collect();
    let rejected = verdicts.iter().any(|v| matches!(v, Verdict::Rejected(_) | Verdict::DeleteMissing));

    if delete && !remote.caps.contains("delete-refs") && sending.iter().any(|(u, _)| u.src.is_none()) {
        return fatal("the receiving end does not support --delete");
    }
    // What the remote answers about each ref we send (`ok` / `ng <reason>`); also its unpack result.
    let mut answers: HashMap<String, Option<String>> = HashMap::new();
    if !sending.is_empty() && !dry {
        let sideband = remote.caps.contains("side-band-64k");
        let mut caps = vec!["report-status"];
        if sideband {
            caps.push("side-band-64k");
        }
        if remote.caps.contains("delete-refs") {
            caps.push("delete-refs");
        }
        caps.push("agent=git/runbun");
        let zero = ObjectId::null(gix::hash::Kind::Sha1);
        let mut body = Vec::new();
        for (i, (u, v)) in sending.iter().enumerate() {
            let old = match v {
                Verdict::FastForward(o) | Verdict::Forced(o) | Verdict::Delete(o) => *o,
                _ => zero,
            };
            let new = u.src.unwrap_or(zero);
            let mut cmd = format!("{old} {new} {}", u.dst).into_bytes();
            if i == 0 {
                cmd.push(0);
                cmd.extend_from_slice(caps.join(" ").as_bytes());
            }
            cmd.push(b'\n');
            pkt(&mut body, &cmd);
        }
        body.extend_from_slice(b"0000");
        let tips: Vec<ObjectId> = sending.iter().filter_map(|(u, _)| u.src).collect();
        if !tips.is_empty() {
            let objs = objects(&ctx.repo, &tips, &remote.refs.values().copied().collect::<Vec<_>>())?;
            crate::http::report(&format!("Writing {} objects", objs.len()));
            body.extend_from_slice(&pack(&ctx.repo, &objs)?);
        }
        crate::http::report(&format!("Pushing to {}", host_of(base)));
        let res = crate::http::request(
            "POST",
            &format!("{base}/git-receive-pack"),
            &["Content-Type: application/x-git-receive-pack-request", "Accept: application/x-git-receive-pack-result"],
            body,
        )
        .map_err(unreachable)?;
        let status = report_status(&res, sideband)?;
        if let Some(unpack) = status.iter().find_map(|l| l.strip_prefix("unpack ")).filter(|s| *s != "ok") {
            eprintln!("error: remote unpack failed: {unpack}");
        }
        for l in &status {
            if let Some(r) = l.strip_prefix("ok ") {
                answers.insert(r.to_string(), None);
            } else if let Some(rest) = l.strip_prefix("ng ") {
                let (r, why) = rest.split_once(' ').unwrap_or((rest, "failed"));
                answers.insert(r.to_string(), Some(why.to_string()));
            }
        }
    }

    if verdicts.iter().all(|v| matches!(v, Verdict::UpToDate)) {
        eprintln!("Everything up-to-date");
        return Ok(0);
    }
    eprintln!("To {url}");
    let mut failed = rejected;
    let mut pushed = Vec::new();
    for (u, v) in list.iter().zip(&verdicts) {
        let from = u.branch.as_deref().map(|b| short(&format!("refs/heads/{b}")).to_string()).unwrap_or_else(|| u.src.map(|s| s.to_hex_with_len(7).to_string()).unwrap_or_default());
        let to = short(&u.dst);
        let sent = matches!(v, Verdict::New | Verdict::FastForward(_) | Verdict::Forced(_) | Verdict::Delete(_));
        if sent && !dry {
            match answers.get(&u.dst) {
                Some(None) => {}
                Some(Some(why)) => {
                    line('!', "[remote rejected]", &from, to, why);
                    failed = true;
                    continue;
                }
                None => {
                    line('!', "[remote failure]", &from, to, "remote failed to report status");
                    failed = true;
                    continue;
                }
            }
        }
        let new = u.src.map(|s| s.to_hex_with_len(7).to_string()).unwrap_or_default();
        match v {
            Verdict::UpToDate => line('=', "[up to date]", &from, to, ""),
            Verdict::New if u.dst.starts_with("refs/tags/") => line('*', "[new tag]", &from, to, ""),
            Verdict::New => line('*', "[new branch]", &from, to, ""),
            Verdict::FastForward(o) => line(' ', &format!("{}..{new}", o.to_hex_with_len(7)), &from, to, ""),
            Verdict::Forced(o) => line('+', &format!("{}...{new}", o.to_hex_with_len(7)), &from, to, "forced update"),
            Verdict::Delete(_) => line('-', "[deleted]", "", to, ""),
            Verdict::Rejected(why) => line('!', "[rejected]", &from, to, why),
            Verdict::DeleteMissing => {
                eprintln!("error: unable to delete '{to}': remote ref does not exist");
                continue;
            }
        }
        if sent && !dry {
            pushed.push(u);
        }
    }

    // Our view of the remote: its tracking refs, as a fetch would leave them.
    let repo = crate::history::with_committer(ctx)?;
    for u in &pushed {
        let Some(branch) = u.dst.strip_prefix("refs/heads/") else { continue };
        let tracking = format!("refs/remotes/{name}/{branch}");
        match u.src {
            Some(id) => {
                repo.reference(tracking.as_str(), id, PreviousValue::Any, "update by push")?;
            }
            None => {
                if let Ok(r) = repo.find_reference(tracking.as_str()) {
                    let _ = r.delete();
                }
            }
        }
    }
    if upstream && !dry {
        let mut cfg = crate::config::load()?;
        for u in &pushed {
            let (Some(b), Some(dst)) = (&u.branch, u.dst.strip_prefix("refs/heads/")) else { continue };
            let sub = Some(b.as_bytes().as_bstr());
            cfg.set_raw_value_by("branch", sub, "remote", name.as_bytes().as_bstr())?;
            cfg.set_raw_value_by("branch", sub, "merge", u.dst.as_bytes().as_bstr())?;
            out(&format!("branch '{b}' set up to track '{name}/{dst}'.\n"));
        }
        crate::config::save(&cfg)?;
    }
    if failed {
        if verdicts.iter().any(|v| matches!(v, Verdict::Rejected(_))) {
            eprintln!("hint: Updates were rejected because the remote contains work that you do not have locally.");
            eprintln!("hint: Fetch and integrate the remote changes (git pull) before pushing again, or push with --force.");
        }
        eprintln!("error: failed to push some refs to '{url}'");
        return Ok(1);
    }
    Ok(0)
}
