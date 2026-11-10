// `git config` over the repository's own config file (/.git/config): get, set, --unset, --list.
use crate::{Exit, Res, error, fatal, out, positional};
use gix::bstr::ByteSlice;
use gix::config::{File, Source};

const PATH: &str = "/.git/config";

fn load() -> Result<File, Exit> {
    Ok(File::from_path_no_includes(PATH.into(), Source::Local)?)
}

fn save(f: &File) -> Result<(), Exit> {
    std::fs::write(PATH, f.to_bstring())?;
    Ok(())
}

/// `a.b.c.name` -> (`a`, Some(`b.c`), `name`); section and name are case-insensitive, the subsection is not.
fn split(key: &str) -> Result<(String, Option<String>, String), Exit> {
    let (Some(first), Some(last)) = (key.find('.'), key.rfind('.')) else {
        return error(format!("key does not contain a section: {key}"));
    };
    if last + 1 == key.len() {
        return error(format!("key does not contain variable name: {key}"));
    }
    let sub = (first != last).then(|| key[first + 1..last].to_string());
    Ok((key[..first].to_lowercase(), sub, key[last + 1..].to_lowercase()))
}

pub fn config(args: &[String]) -> Res {
    let (mut list, mut unset, mut get) = (false, false, false);
    for a in args {
        match a.as_str() {
            "--local" => {}
            "--global" | "--system" | "--worktree" | "--file" | "-f" => return fatal("only --local config in the playground"),
            "-l" | "--list" => list = true,
            "--unset" => unset = true,
            "--get" => get = true,
            a if a.starts_with('-') && a.len() > 1 && a != "--" => {
                return Err(Exit { code: 129, msg: format!("error: unknown option `{}'", a.trim_start_matches('-')) });
            }
            _ => {}
        }
    }
    let pos = positional(args);
    let mut file = load()?;
    if list {
        for s in file.sections() {
            let (sec, sub) = (s.header().name().to_str_lossy().to_lowercase(), s.header().subsection_name().map(|b| b.to_str_lossy().into_owned()));
            let mut seen = Vec::new();
            for name in s.value_names() {
                let lower = name.to_lowercase();
                if seen.contains(&lower) {
                    continue;
                }
                for v in s.values(&name) {
                    let key = match &sub {
                        Some(sub) => format!("{sec}.{sub}.{lower}"),
                        None => format!("{sec}.{lower}"),
                    };
                    out(&format!("{key}={}\n", v.to_str_lossy()));
                }
                seen.push(lower);
            }
        }
        return Ok(0);
    }
    let Some(key) = pos.first() else { return Err(Exit { code: 129, msg: "usage: git config [--local] <name> [<value>] | --get <name> | --unset <name> | --list".into() }) };
    let (sec, sub, name) = split(key)?;
    if unset {
        let full = match &sub {
            Some(sub) => format!("{sec}.{sub}.{name}"),
            None => format!("{sec}.{name}"),
        };
        return match file.raw_values_mut(full.as_str()) {
            Ok(mut v) => {
                v.delete_all();
                save(&file)?;
                Ok(0)
            }
            Err(_) => Ok(5),
        };
    }
    match pos.get(1) {
        Some(value) if !get => {
            file.set_raw_value_by(sec.as_str(), sub.as_deref().map(|s| s.as_bytes().as_bstr()), name.as_str(), value.as_bytes().as_bstr())
                .map_err(|e| Exit { code: 128, msg: format!("fatal: {e}") })?;
            save(&file)?;
            Ok(0)
        }
        _ => match file.raw_value_by(sec.as_str(), sub.as_deref().map(|s| s.as_bytes().as_bstr()), name.as_str()) {
            Ok(v) => {
                out(&format!("{}\n", v.to_str_lossy()));
                Ok(0)
            }
            Err(_) => Ok(1),
        },
    }
}
