//! `Bun.YAML.parse`, `Bun.TOML.parse` and `.yaml`/`.toml`/`.jsonc`/`.json5` imports: Bun's own parsers (`bun_parsers`,
//! the JSONC and JSON5 ones its runtime loads those files with), with the tree
//! handed to the host as JSON it rebuilds the values from (`resolver.ts` `parseData`).
//!
//! The JSON is `{"root": V, "nodes": [N...]}`. A value `V` is a JSON null/boolean/finite number/string, or an array:
//! `[0, i]` the array or object `nodes[i]`, `[1, "NaN" | "Infinity" | "-Infinity"]`, or `[2, kind, text]` a TOML
//! date/time (`kind` as `E::TomlDateTimeKind`: 1 Instant, 2 PlainDateTime, 3 PlainDate, 4 PlainTime; Bun makes
//! `Temporal.*.from(text)`). A node is `{"a": [V...]}` or `{"o": [[K, V]...]}`. Containers are listed once by identity,
//! so YAML aliases stay shared and cyclic ones stay cyclic, as with Bun's `ParserCtx::to_js`.

use bun_ast::{Expr, ExprData};
use bun_parsers::json::parse_package_json_utf8;
use bun_parsers::json5::JSON5Parser;
use bun_parsers::toml::TOML;
use bun_parsers::yaml::{CyclicAliases, YAML};
use std::collections::HashMap;

pub const YAML_FORMAT: u32 = 0;
pub const TOML_FORMAT: u32 = 1;
pub const JSONC_FORMAT: u32 = 2;
pub const JSON5_FORMAT: u32 = 3;

struct Writer<'a> {
    arena: &'a bun_alloc::Arena,
    out: Vec<u8>,
    nodes: Vec<Vec<u8>>,
    ids: HashMap<*const (), usize>,
}

fn json_string(out: &mut Vec<u8>, s: &[u8]) {
    out.push(b'"');
    for &b in s {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0..0x20 => out.extend_from_slice(format!("\\u{b:04x}").as_bytes()),
            _ => out.push(b),
        }
    }
    out.push(b'"');
}

impl Writer<'_> {
    /// Appends `expr` as a value to `out`; containers go to `nodes` (first time) and are referenced.
    fn value(&mut self, expr: &Expr, out: &mut Vec<u8>) -> Result<(), &'static str> {
        match &expr.data {
            ExprData::ENull(_) | ExprData::EUndefined(_) => out.extend_from_slice(b"null"),
            ExprData::EBoolean(b) => out.extend_from_slice(if b.value { b"true" } else { b"false" }),
            ExprData::ENumber(n) => {
                let v = n.value();
                if v.is_nan() {
                    out.extend_from_slice(b"[1,\"NaN\"]");
                } else if v.is_infinite() {
                    out.extend_from_slice(if v > 0.0 { b"[1,\"Infinity\"]" } else { b"[1,\"-Infinity\"]" });
                } else if v == 0.0 && v.is_sign_negative() {
                    out.extend_from_slice(b"-0");
                } else {
                    // Rust's shortest round-trip form; JSON.parse reads it back to the same double.
                    out.extend_from_slice(format!("{v:?}").as_bytes());
                }
            }
            ExprData::EString(s) => {
                let s = s.get();
                let text = s.string(self.arena).map_err(|_| "OutOfMemory")?;
                if let Some(kind) = s.toml_datetime {
                    out.extend_from_slice(format!("[2,{},", kind as u8).as_bytes());
                    json_string(out, text);
                    out.push(b']');
                } else {
                    json_string(out, text);
                }
            }
            ExprData::EArray(a) => {
                let id = self.node(a.as_ptr().cast_const().cast(), |w, buf| {
                    buf.extend_from_slice(b"{\"a\":[");
                    for (i, item) in a.slice().iter().enumerate() {
                        if i > 0 {
                            buf.push(b',');
                        }
                        w.value(item, buf)?;
                    }
                    buf.extend_from_slice(b"]}");
                    Ok(())
                })?;
                out.extend_from_slice(format!("[0,{id}]").as_bytes());
            }
            ExprData::EObject(o) => {
                let id = self.node(o.as_ptr().cast_const().cast(), |w, buf| {
                    buf.extend_from_slice(b"{\"o\":[");
                    for (i, prop) in o.properties.iter().enumerate() {
                        let (Some(k), Some(v)) = (&prop.key, &prop.value) else { return Err("unexpected property") };
                        if i > 0 {
                            buf.push(b',');
                        }
                        buf.push(b'[');
                        w.value(k, buf)?;
                        buf.push(b',');
                        w.value(v, buf)?;
                        buf.push(b']');
                    }
                    buf.extend_from_slice(b"]}");
                    Ok(())
                })?;
                out.extend_from_slice(format!("[0,{id}]").as_bytes());
            }
            _ => return Err("unexpected value"),
        }
        Ok(())
    }

    /// The id of the container at `key`, writing it with `fill` the first time. The id is taken before filling, so a
    /// container that contains itself refers to its own id.
    fn node(&mut self, key: *const (), fill: impl FnOnce(&mut Self, &mut Vec<u8>) -> Result<(), &'static str>) -> Result<usize, &'static str> {
        if let Some(&id) = self.ids.get(&key) {
            return Ok(id);
        }
        let id = self.nodes.len();
        self.ids.insert(key, id);
        self.nodes.push(Vec::new());
        let mut buf = Vec::new();
        fill(self, &mut buf)?;
        self.nodes[id] = buf;
        Ok(id)
    }
}

/// Parses `text` as YAML (`format` 0), TOML (1), JSONC (2) or JSON5 (3). Err: Bun's error message (`YAML Parse error: …`).
pub fn parse(text: &[u8], format: u32) -> Result<Vec<u8>, Vec<u8>> {
    let (name, path): (&[u8], &[u8]) = match format {
        TOML_FORMAT => (b"TOML", b"input.toml"),
        JSONC_FORMAT => (b"JSONC", b"input.jsonc"),
        JSON5_FORMAT => (b"JSON5", b"input.json5"),
        _ => (b"YAML", b"input.yaml"),
    };
    let fail = |what: &[u8]| {
        let mut m = name.to_vec();
        m.extend_from_slice(b" Parse error: ");
        m.extend_from_slice(what);
        m
    };
    let arena = bun_alloc::Arena::new();
    let mut ast_memory_allocator = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _scope = ast_memory_allocator.enter();
    let mut log = bun_ast::Log::init();
    let source = bun_ast::Source::init_path_string(path, text);
    let root = match format {
        TOML_FORMAT => TOML::parse(&source, &mut log, &arena, false).map_err(|e| format!("{e:?}")),
        // package.json's dialect is JSONC (comments, trailing commas), parsed to the classic AST the writer walks.
        JSONC_FORMAT => parse_package_json_utf8(&source, &mut log, &arena).map_err(|e| format!("{e:?}")),
        JSON5_FORMAT => JSON5Parser::parse(&source, &mut log, &arena).map_err(|e| format!("{e:?}")),
        _ => YAML::parse(&source, &mut log, &arena, CyclicAliases::Allow).map_err(|e| format!("{e:?}")),
    };
    let root = match root {
        Ok(root) => root,
        Err(e) => {
            return Err(match log.msgs.first() {
                Some(m) => fail(&m.data.text),
                None if e.contains("StackOverflow") => b"Maximum call stack size exceeded.".to_vec(),
                None if format == TOML_FORMAT => fail(b"Unable to parse TOML"),
                None if format == YAML_FORMAT => fail(b"Unable to parse YAML string"),
                None => fail(b"Unable to parse"),
            });
        }
    };
    let mut w = Writer { arena: &arena, out: Vec::new(), nodes: Vec::new(), ids: HashMap::new() };
    let mut root_out = Vec::new();
    w.value(&root, &mut root_out).map_err(|e| fail(e.as_bytes()))?;
    w.out.extend_from_slice(b"{\"root\":");
    w.out.extend_from_slice(&root_out);
    w.out.extend_from_slice(b",\"nodes\":[");
    for (i, n) in w.nodes.iter().enumerate() {
        if i > 0 {
            w.out.push(b',');
        }
        w.out.extend_from_slice(n);
    }
    w.out.extend_from_slice(b"]}");
    Ok(w.out)
}
