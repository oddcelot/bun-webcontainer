//! `DEBUG`: instrument a file for the playground's step debugger. Before each statement a probe
//! `__dbg(file, id) && __dbg.p(__dbg$n => eval(__dbg$n))` asks the runtime's global `__dbg` whether a breakpoint or a
//! step wants that statement; only then is the arrow made, and `__dbg.p` pauses with it: a direct eval at the
//! statement reads every variable in scope there, so the runtime gets locals without a V8 inspector.
//! A `debugger;` statement becomes a probe that always pauses (a third argument, 1).
//!
//! The table appended to the output (`table_json`) says, per probe, its source line and column (0-based, UTF-16)
//! and its scope; per scope, its parent, kind and the names it declares.

use bun_alloc::Arena;
use bun_ast::expr::Data;
use bun_ast::stmt::Data as StmtData;
use bun_ast::{self as ast, E, Expr, G, Loc, Ref, S, Stmt, StmtOrExpr, b, b::B};
use bun_collections::VecExt as _;

const MODULE: u8 = 0;
const FUNCTION: u8 = 1;
const BLOCK: u8 = 2;

struct Scope {
    parent: i32,
    kind: u8,
    names: Vec<Vec<u8>>,
}

struct Probe {
    loc: u32,
    scope: u32,
    debugger: bool,
}

pub struct Instrument<'a, 's> {
    arena: &'a Arena,
    symbols: &'s [ast::Symbol],
    file: f64,
    dbg: Ref,
    eval: Ref,
    arg: Ref,
    scopes: Vec<Scope>,
    stack: Vec<u32>,
    probes: Vec<Probe>,
}

/// A 31-bit hash of the path: the runtime and the page name the file by it.
pub fn file_id(path: &[u8]) -> u32 {
    // FNV-1a.
    let mut h: u32 = 0x811c9dc5;
    for &c in path {
        h ^= c as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h & 0x7fff_ffff
}

/// Instruments `ast` in place and returns the table (JSON).
pub fn instrument<'a>(ast: &mut ast::Ast<'a>, arena: &'a Arena, path: &[u8], source: &[u8]) -> Vec<u8> {
    let source_index = ast.require_ref.source_index();
    let mut new_symbol = |name: &'static [u8], kind: ast::SymbolKind| {
        let inner = ast.symbols.len() as u32;
        ast.symbols.push(ast::Symbol { kind, original_name: ast::StoreStr::new(name), ..Default::default() });
        Ref::new(inner, source_index, ast::base::RefTag::Symbol)
    };
    let dbg = new_symbol(b"__dbg", ast::SymbolKind::Unbound);
    let eval = new_symbol(b"eval", ast::SymbolKind::Unbound);
    let arg = new_symbol(b"__dbg$n", ast::SymbolKind::Hoisted);

    let symbols: &[ast::Symbol] = &ast.symbols;
    let mut ins = Instrument {
        arena,
        symbols,
        file: file_id(path) as f64,
        dbg,
        eval,
        arg,
        scopes: Vec::new(),
        stack: Vec::new(),
        probes: Vec::new(),
    };

    // The module scope spans every part; its names are those of all of them.
    let mut names = Vec::new();
    for part in ast.parts.iter() {
        ins.declared(part.stmts.slice(), true, &mut names);
    }
    ins.push_scope(MODULE, names);
    for part in ast.parts.iter_mut() {
        part.stmts = ins.stmt_list(part.stmts.slice());
    }
    ins.stack.pop();
    ins.table_json(source)
}

impl<'a, 's> Instrument<'a, 's> {
    fn name(&self, r: Ref) -> Option<Vec<u8>> {
        if !r.is_valid() {
            return None;
        }
        self.symbols.get(r.inner_index() as usize).map(|s| s.original_name.slice().to_vec())
    }

    fn push_name(&self, r: Ref, out: &mut Vec<Vec<u8>>) {
        if let Some(n) = self.name(r) {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }

    fn binding_names(&self, binding: &ast::Binding, out: &mut Vec<Vec<u8>>) {
        match &binding.data {
            B::BIdentifier(id) => self.push_name(id.r#ref, out),
            B::BArray(array) => {
                for item in array.items.slice() {
                    self.binding_names(&item.binding, out);
                }
            }
            B::BObject(object) => {
                for property in object.properties.slice() {
                    self.binding_names(&property.value, out);
                }
            }
            B::BMissing(_) => {}
        }
    }

    /// What `stmts` declare in their scope: `let`, `const`, `class`, functions and imports; with `vars`, also the
    /// `var`s anywhere in them (not in nested functions), for a function's or the module's scope.
    fn declared(&self, stmts: &[Stmt], vars: bool, out: &mut Vec<Vec<u8>>) {
        for stmt in stmts {
            self.declared_stmt(stmt, vars, true, out);
        }
    }

    fn declared_stmt(&self, stmt: &Stmt, vars: bool, direct: bool, out: &mut Vec<Vec<u8>>) {
        match &stmt.data {
            StmtData::SLocal(local) => {
                if direct || (vars && local.kind == S::Kind::KVar) {
                    for decl in local.decls.iter() {
                        self.binding_names(&decl.binding, out);
                    }
                }
            }
            StmtData::SFunction(s) if direct => {
                if let Some(name) = &s.func.name {
                    self.push_name(name.ref_, out);
                }
            }
            StmtData::SClass(s) if direct => {
                if let Some(name) = &s.class.class_name {
                    self.push_name(name.ref_, out);
                }
            }
            StmtData::SImport(s) if direct => {
                if let Some(name) = &s.default_name {
                    self.push_name(name.ref_, out);
                }
                if s.star_name_loc != Loc::EMPTY {
                    self.push_name(s.namespace_ref, out);
                }
                for item in s.items.slice() {
                    self.push_name(item.name.ref_, out);
                }
            }
            StmtData::SExportDefault(s) if direct => {
                if let StmtOrExpr::Stmt(inner) = &s.value {
                    self.declared_stmt(inner, vars, true, out);
                }
            }
            _ if !vars => {}
            StmtData::SBlock(s) => self.nested(s.stmts.slice(), out),
            StmtData::SIf(s) => {
                self.declared_stmt(&s.yes, vars, false, out);
                if let Some(no) = &s.no {
                    self.declared_stmt(no, vars, false, out);
                }
            }
            StmtData::SFor(s) => {
                if let Some(init) = &s.init {
                    self.declared_stmt(init, vars, false, out);
                }
                self.declared_stmt(&s.body, vars, false, out);
            }
            StmtData::SForIn(s) => {
                self.declared_stmt(&s.init, vars, false, out);
                self.declared_stmt(&s.body, vars, false, out);
            }
            StmtData::SForOf(s) => {
                self.declared_stmt(&s.init, vars, false, out);
                self.declared_stmt(&s.body, vars, false, out);
            }
            StmtData::SWhile(s) => self.declared_stmt(&s.body, vars, false, out),
            StmtData::SDoWhile(s) => self.declared_stmt(&s.body, vars, false, out),
            StmtData::SLabel(s) => self.declared_stmt(&s.stmt, vars, false, out),
            StmtData::SSwitch(s) => {
                for case in s.cases.slice() {
                    self.nested(case.body.slice(), out);
                }
            }
            StmtData::STry(s) => {
                self.nested(s.body.slice(), out);
                if let Some(catch) = &s.catch {
                    self.nested(catch.body.slice(), out);
                }
                if let Some(finally) = &s.finally {
                    self.nested(finally.stmts.slice(), out);
                }
            }
            _ => {}
        }
    }

    fn nested(&self, stmts: &[Stmt], out: &mut Vec<Vec<u8>>) {
        for stmt in stmts {
            self.declared_stmt(stmt, true, false, out);
        }
    }

    fn push_scope(&mut self, kind: u8, names: Vec<Vec<u8>>) {
        let parent = self.stack.last().map_or(-1, |&p| p as i32);
        self.scopes.push(Scope { parent, kind, names });
        self.stack.push((self.scopes.len() - 1) as u32);
    }

    fn ident(&self, r: Ref) -> Expr {
        Expr::init_identifier(r, Loc::EMPTY)
    }

    /// `__dbg$n => eval(__dbg$n)`
    fn scoped_eval(&self) -> Expr {
        let call = Expr::init(
            E::Call {
                target: self.ident(self.eval),
                args: ast::ExprNodeList::from_slice(&[self.ident(self.arg)]),
                is_direct_eval: true,
                ..Default::default()
            },
            Loc::EMPTY,
        );
        let body = G::FnBody::init_return_expr(self.arena, call).expect("OOM");
        let args = self.arena.alloc_slice_fill_with(1, |_| G::Arg {
            binding: ast::Binding::alloc(self.arena, b::Identifier { r#ref: self.arg }, Loc::EMPTY),
            ..Default::default()
        });
        Expr::init(E::Arrow { args: ast::StoreSlice::new_mut(args), body, prefer_expr: true, ..Default::default() }, Loc::EMPTY)
    }

    /// `__dbg(file, id) && __dbg.p(__dbg$n => eval(__dbg$n))` for the statement at `loc`.
    fn probe(&mut self, loc: Loc, debugger: bool) -> Stmt {
        let id = self.probes.len();
        self.probes.push(Probe { loc: loc.start.max(0) as u32, scope: *self.stack.last().expect("a scope"), debugger });
        let num = |n: f64| Expr::init(E::Number::new(n), loc);
        let mut args = vec![num(self.file), num(id as f64)];
        if debugger {
            args.push(num(1.0));
        }
        let ask = Expr::init(E::Call { target: self.ident(self.dbg), args: ast::ExprNodeList::from_slice(&args), ..Default::default() }, loc);
        let pause = Expr::init(
            E::Call {
                target: Expr::init(E::Dot { target: self.ident(self.dbg), name: b"p".into(), name_loc: loc, ..Default::default() }, loc),
                args: ast::ExprNodeList::from_slice(&[self.scoped_eval()]),
                ..Default::default()
            },
            loc,
        );
        Stmt::alloc(
            S::SExpr { value: Expr::init(E::Binary { left: ask, right: pause, op: ast::OpCode::BinLogicalAnd }, loc), does_not_affect_tree_shaking: true },
            loc,
        )
    }

    /// A statement list with a probe before each statement. Its scope is already pushed.
    fn stmt_list(&mut self, stmts: &[Stmt]) -> ast::StoreSlice<Stmt> {
        let mut out: Vec<Stmt> = Vec::with_capacity(stmts.len() * 2);
        for &stmt in stmts {
            match stmt.data {
                StmtData::SDebugger(_) => {
                    out.push(self.probe(stmt.loc, true));
                    continue;
                }
                StmtData::SFunction(_)
                | StmtData::SImport(_)
                | StmtData::SExportFrom(_)
                | StmtData::SExportStar(_)
                | StmtData::SExportClause(_)
                | StmtData::SDirective(_)
                | StmtData::SEmpty(_)
                | StmtData::SComment(_)
                | StmtData::STypeScript(_) => {}
                StmtData::SExportDefault(s) if matches!(s.value, StmtOrExpr::Stmt(_)) => {}
                _ => out.push(self.probe(stmt.loc, false)),
            }
            self.stmt(stmt);
            out.push(stmt);
        }
        ast::StoreSlice::new_mut(self.arena.alloc_slice_copy(&out))
    }

    /// A block's statements: a scope of its own in the table if they declare something (or `extra`, a loop's or
    /// catch's bindings, is non-empty).
    fn block(&mut self, stmts: &[Stmt], extra: Vec<Vec<u8>>) -> ast::StoreSlice<Stmt> {
        let mut names = extra;
        self.declared(stmts, false, &mut names);
        if names.is_empty() {
            return self.stmt_list(stmts);
        }
        self.push_scope(BLOCK, names);
        let out = self.stmt_list(stmts);
        self.stack.pop();
        out
    }

    /// A loop's or `if`'s body: a single statement becomes a block so it gets a probe.
    fn body(&mut self, stmt: Stmt, extra: Vec<Vec<u8>>) -> Stmt {
        match stmt.data {
            StmtData::SBlock(mut block) => {
                block.stmts = self.block(block.stmts.slice(), extra);
                stmt
            }
            _ => {
                let stmts = self.block(&[stmt], extra);
                Stmt::alloc(S::Block { stmts, ..Default::default() }, stmt.loc)
            }
        }
    }

    fn function_body(&mut self, args: &[G::Arg], own_name: Option<Ref>, body: &mut G::FnBody) {
        let mut names = Vec::new();
        if let Some(r) = own_name {
            self.push_name(r, &mut names);
        }
        for arg in args {
            self.binding_names(&arg.binding, &mut names);
        }
        self.declared(body.stmts.slice(), true, &mut names);
        for arg in args {
            if let Some(default) = arg.default {
                self.expr(default);
            }
        }
        self.push_scope(FUNCTION, names);
        body.stmts = self.stmt_list(body.stmts.slice());
        self.stack.pop();
    }

    fn func(&mut self, func: &mut G::Fn, is_expression: bool) {
        let own = if is_expression { func.name.as_ref().map(|n| n.ref_) } else { None };
        let args = func.args.slice();
        self.function_body(args, own, &mut func.body);
    }

    fn class(&mut self, class: &mut G::Class) {
        if let Some(extends) = class.extends {
            self.expr(extends);
        }
        for property in class.properties.slice_mut() {
            if let Some(key) = property.key {
                self.expr(key);
            }
            if let Some(value) = property.value {
                self.expr(value);
            }
            if let Some(init) = property.initializer {
                self.expr(init);
            }
            if let Some(block) = property.class_static_block_mut() {
                let mut body = G::FnBody { loc: block.loc, stmts: ast::StoreSlice::new(block.stmts.as_slice()) };
                self.function_body(&[], None, &mut body);
                block.stmts = bun_alloc::AstAlloc::vec();
                for &s in body.stmts.slice() {
                    block.stmts.push(s);
                }
            }
        }
    }

    fn stmt(&mut self, stmt: Stmt) {
        match stmt.data {
            StmtData::SBlock(mut s) => s.stmts = self.block(s.stmts.slice(), Vec::new()),
            StmtData::SExpr(s) => self.expr(s.value),
            StmtData::SLocal(s) => {
                for decl in s.decls.iter() {
                    if let Some(v) = decl.value {
                        self.expr(v);
                    }
                }
            }
            StmtData::SReturn(s) => {
                if let Some(v) = s.value {
                    self.expr(v);
                }
            }
            StmtData::SThrow(s) => self.expr(s.value),
            StmtData::SIf(mut s) => {
                self.expr(s.test);
                s.yes = self.body(s.yes, Vec::new());
                if let Some(no) = s.no {
                    // `else if` stays one: the inner `if` gets its own probe from the block.
                    s.no = Some(self.body(no, Vec::new()));
                }
            }
            StmtData::SFor(mut s) => {
                let mut names = Vec::new();
                if let Some(init) = s.init {
                    self.declared_stmt(&init, false, true, &mut names);
                    self.stmt(init);
                }
                if let Some(t) = s.test {
                    self.expr(t);
                }
                if let Some(u) = s.update {
                    self.expr(u);
                }
                s.body = self.body(s.body, names);
            }
            StmtData::SForIn(mut s) => {
                let mut names = Vec::new();
                self.declared_stmt(&s.init, false, true, &mut names);
                self.expr(s.value);
                s.body = self.body(s.body, names);
            }
            StmtData::SForOf(mut s) => {
                let mut names = Vec::new();
                self.declared_stmt(&s.init, false, true, &mut names);
                self.expr(s.value);
                s.body = self.body(s.body, names);
            }
            StmtData::SWhile(mut s) => {
                self.expr(s.test);
                s.body = self.body(s.body, Vec::new());
            }
            StmtData::SDoWhile(mut s) => {
                s.body = self.body(s.body, Vec::new());
                self.expr(s.test);
            }
            StmtData::SLabel(mut s) => {
                // A label must stay on its loop: instrument the loop's body, not the labeled statement.
                if matches!(s.stmt.data, StmtData::SFor(_) | StmtData::SForIn(_) | StmtData::SForOf(_) | StmtData::SWhile(_) | StmtData::SDoWhile(_)) {
                    self.stmt(s.stmt);
                } else {
                    s.stmt = self.body(s.stmt, Vec::new());
                }
            }
            StmtData::SWith(mut s) => {
                self.expr(s.value);
                s.body = self.body(s.body, Vec::new());
            }
            StmtData::SSwitch(s) => {
                self.expr(s.test);
                // The cases share one scope.
                let mut names = Vec::new();
                for case in s.cases.slice() {
                    self.declared(case.body.slice(), false, &mut names);
                }
                let scoped = !names.is_empty();
                if scoped {
                    self.push_scope(BLOCK, names);
                }
                for case in s.cases.slice_mut() {
                    if let Some(v) = case.value {
                        self.expr(v);
                    }
                    case.body = self.stmt_list(case.body.slice());
                }
                if scoped {
                    self.stack.pop();
                }
            }
            StmtData::STry(mut s) => {
                s.body = self.block(s.body.slice(), Vec::new());
                if let Some(catch) = s.catch.as_mut() {
                    let mut names = Vec::new();
                    if let Some(binding) = &catch.binding {
                        self.binding_names(binding, &mut names);
                    }
                    catch.body = self.block(catch.body.slice(), names);
                }
                if let Some(finally) = s.finally.as_mut() {
                    finally.stmts = self.block(finally.stmts.slice(), Vec::new());
                }
            }
            StmtData::SFunction(mut s) => self.func(&mut s.func, false),
            StmtData::SClass(mut s) => self.class(&mut s.class),
            StmtData::SExportDefault(s) => match s.value {
                StmtOrExpr::Stmt(inner) => self.stmt(inner),
                StmtOrExpr::Expr(e) => self.expr(e),
            },
            StmtData::SExportEquals(s) => self.expr(s.value),
            _ => {}
        }
    }

    fn expr(&mut self, expr: Expr) {
        let mut expr = expr;
        // `a + b + c + ...` is as deep to the left as it is long.
        while let Data::EBinary(e) = expr.data {
            self.expr(e.right);
            expr = e.left;
        }
        match expr.data {
            Data::EBinary(_) => unreachable!(),
            Data::EDot(e) => self.expr(e.target),
            Data::EIndex(e) => {
                self.expr(e.target);
                self.expr(e.index);
            }
            Data::ECall(e) => {
                self.expr(e.target);
                for &a in e.args.iter() {
                    self.expr(a);
                }
            }
            Data::ENew(e) => {
                self.expr(e.target);
                for &a in e.args.iter() {
                    self.expr(a);
                }
            }
            Data::EUnary(e) => self.expr(e.value),
            Data::EArrow(mut e) => {
                // `x => x * 2` gets a block so its expression gets a probe.
                e.prefer_expr = false;
                let args = e.args.slice();
                self.function_body(args, None, &mut e.body);
            }
            Data::EFunction(mut e) => self.func(&mut e.func, true),
            Data::EClass(mut e) => self.class(&mut e),
            Data::EArray(e) => {
                for &i in e.items.iter() {
                    self.expr(i);
                }
            }
            Data::EObject(e) => {
                for p in e.properties.iter() {
                    if let Some(k) = p.key {
                        self.expr(k);
                    }
                    if let Some(v) = p.value {
                        self.expr(v);
                    }
                    if let Some(i) = p.initializer {
                        self.expr(i);
                    }
                }
            }
            Data::ESpread(e) => self.expr(e.value),
            Data::EIf(e) => {
                self.expr(e.test);
                self.expr(e.yes);
                self.expr(e.no);
            }
            Data::EImport(e) => {
                self.expr(e.expr);
                self.expr(e.options);
            }
            Data::EAwait(e) => self.expr(e.value),
            Data::EYield(e) => {
                if let Some(v) = e.value {
                    self.expr(v);
                }
            }
            Data::ETemplate(e) => {
                if let Some(t) = e.tag {
                    self.expr(t);
                }
                for part in e.parts() {
                    self.expr(part.value);
                }
            }
            Data::EInlinedEnum(e) => self.expr(e.value),
            _ => {}
        }
    }

    /// `{"file":id,"probes":[[line,column,scope(,1 for debugger)],...],"scopes":[[parent,kind,[names]],...]}`.
    fn table_json(&self, source: &[u8]) -> Vec<u8> {
        // Line starts, and UTF-16 columns from byte offsets.
        let mut starts = vec![0usize];
        for (i, &c) in source.iter().enumerate() {
            if c == b'\n' {
                starts.push(i + 1);
            }
        }
        let position = |offset: usize| {
            let offset = offset.min(source.len());
            let line = starts.partition_point(|&s| s <= offset) - 1;
            let text = &source[starts[line]..offset];
            let column: usize = String::from_utf8_lossy(text).encode_utf16().count();
            (line, column)
        };
        let mut out = format!("{{\"file\":{},\"probes\":[", self.file as u32).into_bytes();
        for (i, p) in self.probes.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            let (line, column) = position(p.loc as usize);
            out.extend_from_slice(format!("[{line},{column},{}{}]", p.scope, if p.debugger { ",1" } else { "" }).as_bytes());
        }
        out.extend_from_slice(b"],\"scopes\":[");
        for (i, s) in self.scopes.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend_from_slice(format!("[{},{},[", s.parent, s.kind).as_bytes());
            for (j, n) in s.names.iter().enumerate() {
                if j > 0 {
                    out.push(b',');
                }
                crate::json_str(&mut out, n);
            }
            out.extend_from_slice(b"]]");
        }
        out.extend_from_slice(b"]}");
        out
    }
}
