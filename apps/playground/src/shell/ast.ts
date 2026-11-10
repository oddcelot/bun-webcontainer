// The AST Bun's shell parser prints (bun/src/shell_parser/json_fmt.rs): unions are `{ tag: payload }`.

export type Script = { stmts: Stmt[] };
export type Stmt = { exprs: Expr[] };

export type Expr =
  | { cmd: Cmd }
  | { assign: Assign[] }
  | { binary: { op: "And" | "Or"; left: Expr; right: Expr } }
  | { pipeline: { items: PipelineItem[] } }
  | { subshell: Subshell }
  | { if: If }
  | { condexpr: CondExpr };

export type PipelineItem = { cmd: Cmd } | { assigns: Assign[] } | { subshell: Subshell } | { if: If } | { condexpr: CondExpr };

export type Assign = { label: string; value: Atom };

export type RedirectFlags = { stdin: boolean; stdout: boolean; stderr: boolean; append: boolean; duplicate_out: boolean };

/** A file (`> out.txt`), or a JS value from the template (`> ${buffer}`). */
export type Redirect = { atom: Atom } | { jsbuf: { idx: number } };

export type Cmd = { assigns: Assign[]; name_and_args: Atom[]; redirect: RedirectFlags; redirect_file: Redirect | null };

export type Subshell = { script: Script; redirect: Redirect | null; redirect_flags: RedirectFlags };

/** `if <cond>; then <then>; [elif <cond>; then <then>;]… [else <else>;] fi`: else_parts alternate cond, then, …, else. */
export type If = { cond: Stmt[]; then: Stmt[]; else_parts: Stmt[][] };

/** `[[ -f x ]]`, `[[ a == b ]]`: op as written. */
export type CondExpr = { op: string; args: Atom[] };

export type Atom = { simple: SimpleAtom } | { compound: { atoms: SimpleAtom[]; brace_expansion_hint: boolean; glob_hint: boolean } };

export type SimpleAtom =
  | { Text: string }
  | { Var: string }
  /** `$0`…`$9`. */
  | { VarArgv: number }
  /** `""` or `''`: an empty word that still counts as an argument. */
  | { quoted_empty: Record<string, never> }
  | { asterisk: Record<string, never> }
  | { double_asterisk: Record<string, never> }
  | { brace_begin: Record<string, never> }
  | { brace_end: Record<string, never> }
  | { comma: Record<string, never> }
  | { tilde: Record<string, never> }
  | { cmd_subst: { script: Script; quoted: boolean } };
