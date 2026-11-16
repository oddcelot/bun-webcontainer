// A source pass over what Bun's transpiler prints, so `AsyncLocalStorage` survives `await` (worker/node/asyncHooks.ts).
// The browser has no AsyncContext, and a native `await` resumes without calling any function the playground controls
// (not even `then`). So each `await` saves the context before it and puts it back after it:
//
//   await x                  ->  __alsRestore(__alsSave(), await x)
//   try { … } catch { … }    ->  { const __t = __alsSave(); try { … } catch { __alsRestore(__t); … } }   (when the try has an await)
//   for await (… of y) { … } ->  { const __f = __alsSave(); try { for await (… of y) { __alsRestore(__f); … } } finally { __alsRestore(__f); } }
//
// A rejected `await` throws instead of returning, so the `catch` and `finally` blocks restore too; a `for await`
// resumes before its body and after the loop. Everything is inserted within a line, so lines stay the transpiler's;
// restoreContextMapped reports the inserts, for moving the source map's columns (sourceMap.ts, insertColumns).
//
// It reads Bun's printed output, not arbitrary source: `await` is followed by a space there and statements end in `;`.
// When anything doesn't add up (unbalanced brackets) the code is returned as it came.

const enum K {
  Id,
  Punct,
  Lit,
  TplStart, // `…${  (+1)
  TplMid, // }…${   (0)
  TplEnd, // }…`    (-1)
  Eof,
}

const TOKEN = /(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*')|([A-Za-z_$\u0080-￿#][\w$\u0080-￿]*)|(\d[\w.]*|\.\d[\w.]*)|(\?\.(?!\d)|\.\.\.|=>|[-+]{2}|[&|?]{2}=?|[<>*]{1,3}=?|[=!]==?|[\s\S])/y;
const TEMPLATE = /(?:[^`\\$]|\\[\s\S]|\$(?!\{))*(`|\$\{)/y;
/** After these a `/` starts a regular expression. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

class Lexer {
  i: number;
  kind = K.Eof;
  start = 0;
  /** Whether a `/` here starts a regular expression. */
  private regex = true;
  private curly = 0;
  private stack: number[] = [];
  constructor(readonly code: string, i: number) {
    this.i = i;
  }
  text() {
    return this.code.slice(this.start, this.i);
  }
  /** Moves to the next token; false at the end. */
  next(): boolean {
    const { code } = this;
    for (;;) {
      TOKEN.lastIndex = this.i;
      const m = TOKEN.exec(code);
      if (!m) {
        this.kind = K.Eof;
        return false;
      }
      this.start = this.i;
      this.i = TOKEN.lastIndex;
      if (m[1] !== undefined) continue;
      if (m[2] !== undefined) return this.set(K.Lit, false);
      if (m[3] !== undefined) return this.set(K.Id, REGEX_AFTER.has(m[3]));
      if (m[4] !== undefined) return this.set(K.Lit, false);
      const p = m[5];
      switch (p) {
        case "`":
          return this.template(K.TplStart, K.Lit);
        case "{":
          this.curly++;
          return this.set(K.Punct, true);
        case "}":
          if (this.stack.length && this.stack[this.stack.length - 1] === this.curly) {
            this.stack.pop();
            return this.template(K.TplMid, K.TplEnd);
          }
          this.curly--;
          return this.set(K.Punct, false);
        case ")":
        case "]":
          return this.set(K.Punct, false);
        case "/":
          if (this.regex) return this.scanRegex();
          if (code[this.i] === "=") this.i++;
          return this.set(K.Punct, true);
        default:
          return this.set(K.Punct, true);
      }
    }
  }
  private set(kind: K, regex: boolean) {
    this.kind = kind;
    this.regex = regex;
    return true;
  }
  private template(open: K, close: K) {
    TEMPLATE.lastIndex = this.i;
    const m = TEMPLATE.exec(this.code);
    if (!m) {
      this.i = this.code.length;
      return this.set(K.Eof, false);
    }
    this.i = TEMPLATE.lastIndex;
    if (m[1] === "`") return this.set(close, false);
    this.stack.push(this.curly);
    return this.set(open, true);
  }
  private scanRegex() {
    const { code } = this;
    let inClass = false;
    let j = this.i;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === "\\") j++;
      else if (c === "\n") break;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
    }
    j++;
    while (j < code.length && /[a-z]/i.test(code[j])) j++;
    this.i = j;
    return this.set(K.Lit, false);
  }
}

const open = (l: Lexer) => l.kind === K.TplStart || (l.kind === K.Punct && (l.code[l.start] === "(" || l.code[l.start] === "[" || l.code[l.start] === "{") && l.i - l.start === 1);
const close = (l: Lexer) => l.kind === K.TplEnd || (l.kind === K.Punct && (l.code[l.start] === ")" || l.code[l.start] === "]" || l.code[l.start] === "}") && l.i - l.start === 1);

/** `l` is on an opening bracket: moves it to the matching close; false when there is none. */
function skipBalanced(l: Lexer): boolean {
  let depth = 0;
  do {
    if (open(l)) depth++;
    else if (close(l)) depth--;
    if (depth === 0) return true;
  } while (l.next());
  return false;
}

const PREFIX_WORDS = new Set(["await", "typeof", "void", "delete", "new"]);
const PREFIX_PUNCT = new Set(["!", "~", "+", "-", "++", "--"]);

/**
 * Where the operand of the `await` whose keyword ends at `from` ends: its unary expression (prefix operators, a
 * primary, then calls, members and templates). -1 when it isn't one of those (a class, say): that `await` stays as is.
 */
function operandEnd(code: string, from: number): number {
  const l = new Lexer(code, from);
  let end = from;
  const text = () => l.text();
  if (!l.next()) return -1;
  while ((l.kind === K.Id && PREFIX_WORDS.has(text())) || (l.kind === K.Punct && PREFIX_PUNCT.has(text()))) {
    if (!l.next()) return -1;
  }
  // The primary.
  if (l.kind === K.Id) {
    const word = text();
    if (word === "class") return -1;
    if (word === "async" || word === "function") {
      // `async function`, `function` (named or not), `function*`: params then body.
      if (word === "async" && (!l.next() || text() !== "function")) return -1;
      if (!l.next()) return -1;
      if (text() === "*" && !l.next()) return -1;
      if (l.kind === K.Id && !l.next()) return -1;
      if (text() !== "(" || !skipBalanced(l) || !l.next() || text() !== "{" || !skipBalanced(l)) return -1;
    }
    end = l.i;
  } else if (l.kind === K.Punct) {
    if (!open(l)) return -1;
    if (!skipBalanced(l)) return -1;
    end = l.i;
  } else if (l.kind === K.Lit || l.kind === K.TplStart) {
    if (l.kind === K.TplStart && !skipBalanced(l)) return -1;
    end = l.i;
  } else return -1;
  // Members, calls, templates, a postfix operator.
  for (;;) {
    if (!l.next()) return end;
    const t = text();
    if (l.kind === K.Punct && (t === "." || t === "?.")) {
      if (t === "?." && (l.code[l.i] === "(" || l.code[l.i] === "[")) {
        end = l.i;
        continue;
      }
      if (!l.next() || (l.kind as K) !== K.Id) return -1;
      end = l.i;
    } else if (l.kind === K.Punct && (t === "(" || t === "[")) {
      if (!skipBalanced(l)) return -1;
      end = l.i;
    } else if (l.kind === K.TplStart) {
      if (!skipBalanced(l)) return -1;
      end = l.i;
    } else if (l.kind === K.Lit && t.startsWith("`")) {
      end = l.i;
    } else if (l.kind === K.Punct && (t === "++" || t === "--") && !/\n/.test(code.slice(end, l.start))) {
      return l.i;
    } else return end;
  }
}

type Edit = { at: number; text: string };

/** `try` at `at` (the lexer is past it): where its blocks start, or undefined for a shape this doesn't handle. */
function tryShape(code: string, from: number) {
  const l = new Lexer(code, from);
  const block = () => {
    if (!l.next() || l.code[l.start] !== "{") return undefined;
    const from = l.start;
    return skipBalanced(l) ? ([from, l.i] as const) : undefined;
  };
  const body = block();
  if (!body) return undefined;
  let catchAt: number | undefined;
  let finallyAt: number | undefined;
  let end = body[1];
  const probe = new Lexer(code, end);
  if (probe.next() && probe.kind === K.Id && probe.text() === "catch") {
    l.i = probe.i;
    if (!l.next()) return undefined;
    if (l.code[l.start] === "(") {
      if (!skipBalanced(l) || !l.next()) return undefined;
    }
    if (l.code[l.start] !== "{" || !skipBalanced(l)) return undefined;
    catchAt = findBlockOpen(code, end);
    end = l.i;
  }
  const probe2 = new Lexer(code, end);
  if (probe2.next() && probe2.kind === K.Id && probe2.text() === "finally") {
    l.i = probe2.i;
    const fin = block();
    if (!fin) return undefined;
    finallyAt = fin[0];
    end = fin[1];
  }
  return { body, catchAt, finallyAt, end };
}

/** The `{` of the catch clause after the try body that ended at `from`. */
function findBlockOpen(code: string, from: number) {
  const l = new Lexer(code, from);
  l.next(); // catch
  l.next();
  if (code[l.start] === "(") {
    skipBalanced(l);
    l.next();
  }
  return l.start;
}

/** Words a statement starts with that this doesn't look past (where they end isn't a `;` at depth 0). */
const COMPOUND = new Set(["if", "for", "while", "do", "try", "switch", "with", "function", "class", "async", "let", "const", "var"]);

/**
 * `for await (…) body` whose `for` ends at `from`: where the body starts and ends, and whether it is a block. A body
 * that isn't a block is a statement ending in a `;` (what `break;` and `log(x);` do); a compound one isn't handled.
 */
function forAwait(code: string, from: number): { bodyStart: number; end: number; braced: boolean } | undefined {
  const l = new Lexer(code, from);
  if (!l.next() || l.kind !== K.Id || l.text() !== "await" || !l.next() || code[l.start] !== "(" || !skipBalanced(l) || !l.next()) return undefined;
  const bodyStart = l.start;
  if (code[bodyStart] === "{") return skipBalanced(l) ? { bodyStart, end: l.i, braced: true } : undefined;
  if (l.kind === K.Id && COMPOUND.has(l.text())) return undefined;
  let depth = 0;
  do {
    if (open(l)) depth++;
    else if (close(l)) depth--;
    else if (depth === 0 && (l.kind as K) === K.Punct && code[l.start] === ";") return { bodyStart, end: l.i, braced: false };
  } while (depth >= 0 && l.next());
  return undefined;
}

let counter = 0;

/** Text inserted into a line: `[original column, length]`, in column order. */
export type Inserts = Map<number, [number, number][]>;

/** `code` with every `await` (and the `try` and `for await` statements around them) restoring the context. */
export function restoreContext(code: string): string {
  return restoreContextMapped(code).code;
}

/** `restoreContext`, and where it inserted text (per original line), to move a source map's columns by. */
export function restoreContextMapped(code: string): { code: string; inserts: Inserts } {
  const inserts: Inserts = new Map();
  if (!code.includes("await")) return { code, inserts };
  const edits: Edit[] = [];
  const awaits: number[] = [];
  const tries: { start: number; body: readonly [number, number]; catchAt?: number; finallyAt?: number; end: number }[] = [];
  const l = new Lexer(code, 0);
  let prev = "";
  while (l.next()) {
    const t = l.kind === K.Id ? l.text() : "";
    if (l.kind === K.Id && prev !== "." && prev !== "?.") {
      if (t === "await" && prev !== "for" && /\s/.test(code[l.i] ?? "")) {
        const end = operandEnd(code, l.i);
        if (end > 0) {
          edits.push({ at: l.start, text: "__alsRestore(__alsSave()," }, { at: end, text: ")" });
          awaits.push(l.start);
        }
      } else if (t === "try") {
        const shape = tryShape(code, l.i);
        if (shape) tries.push({ start: l.start, ...shape });
      } else if (t === "for") {
        const loop = forAwait(code, l.i);
        if (loop) {
          const name = `__f${counter++}`;
          const save = `__alsRestore(${name});`;
          edits.push(
            { at: l.start, text: `{const ${name}=__alsSave();try{` },
            // Restored at the start of each iteration, and after the loop however it ended.
            { at: loop.braced ? loop.bodyStart + 1 : loop.bodyStart, text: loop.braced ? save : `{${save}` },
            { at: loop.end, text: `${loop.braced ? "" : "}"}}finally{${save}}}` },
          );
        }
      }
    }
    prev = l.kind === K.Id || l.kind === K.Punct ? l.text() : "";
  }
  if (!awaits.length && !edits.length) return { code, inserts };
  for (const t of tries) {
    // Only a try whose block awaits can resume somewhere else.
    const hasAwait = awaits.some((a) => a > t.body[0] && a < t.body[1]);
    if (!hasAwait) continue;
    const name = `__t${counter++}`;
    edits.push({ at: t.start, text: `{const ${name}=__alsSave();` }, { at: t.end, text: "}" });
    if (t.catchAt !== undefined) edits.push({ at: t.catchAt + 1, text: `__alsRestore(${name});` });
    if (t.finallyAt !== undefined) edits.push({ at: t.finallyAt + 1, text: `__alsRestore(${name});` });
  }
  edits.sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  let line = 0;
  let lineStart = 0;
  let scan = 0;
  for (const e of edits) {
    out += code.slice(last, e.at) + e.text;
    last = e.at;
    for (let nl; (nl = code.indexOf("\n", scan)) >= 0 && nl < e.at; scan = nl + 1) {
      line++;
      lineStart = nl + 1;
    }
    const list = inserts.get(line) ?? [];
    list.push([e.at - lineStart, e.text.length]);
    inserts.set(line, list);
  }
  return { code: out + code.slice(last), inserts };
}
