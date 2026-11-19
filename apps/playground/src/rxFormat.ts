// Feasibility prototype: format ReactiveScript (.rx) with a TSX formatter by disguising the module as TSX.
//
// `maskRx` rewrites every rx-only construct into valid TSX of the same shape, tagged with identifiers that do not
// occur in the file (`P`, a per-file prefix such as `__rx0`), and `unmask` undoes the rewrite on whatever a TSX
// formatter made of it. Both work on a token stream that knows strings, templates, comments, regexes and JSX (text,
// tags, `<style>` bodies), so nothing inside those is ever rewritten. The caller proves the result is the same
// program (scripts/rx-format.ts); anything not covered here fails to parse or fails that proof and stays unformatted.
//
// What the disguise is (rx -> TSX):
//   source x: T := e            let x__rx0s: T = e            (S: `=`; d: deferred; x: context; p: provide; q: `x key k =`)
//   source x key k = e          let x__rx0S$k = e
//   x = e / x: T = e / {a} = e  var x = e / var x: T = e / var {a} = e
//   x := e / guess x := e       x |= e / __rx0g: x |= e       refresh x / affects x   __rx0r: x / __rx0h: x   (optimistic: __rx0o)
//   component C(p) { }          function C__rx0c(p) { }       fn f(a): T => e   const f__rx0f = (a): T => e
//   action a() { } / server fn  function a__rx0a() { } / v    action { }   __rx0k: { }
//   effect (a, b) { }           while ([a, b]) { }
//   error E(p) => m             const E__rx0e = (p) => m      (e1: no params, e2: no body, e3: bare)
//   import pure { a } from x    import __rx0p, { a } from x   fails A | B   a following `__rx0z: A | B` line
//   pending? x / latest x / pre x / use x / await* x / throw x    __rx0q(x) / l / e / u / s / t
//   await e -> v                (await e) + __rx0n + v         e catch (x: C) => a    e ? __rx0c : (x: C) => a
//   c ? a : b                   __rx0T(c, a, b)               (a formatter writes `?` / `:` at line starts, rx has none;
//                                                              unmask joins it back, one line or trailing `?` / `:`)
//   draft(e) { b }              __rx0d(e, () => { b })        {expr} as a statement   __rx0m(expr)
//   {if c { A } else { B }}     {__rx0if(c, () => { A }, () => { B })}   (for, lo = loading, er = errored, po = portal;
//                                _s: bare at statement level, _b: braced at statement level, ei: `else if`)
//   <style>css</style>          <style>__rx0css0</style>      (the CSS is stashed and put back verbatim)
//   a markup statement          ;<p>…</p>                     (the formatter writes the same `;`; unmask drops it)

export type Masked = { tsx: string; unmask(formatted: string): string };

// ---------------------------------------------------------------------------------------------------------------
// Tokens

type Kind = "ws" | "lc" | "bc" | "id" | "num" | "str" | "tpl" | "rx" | "p" | "jt" | "jraw";
interface Tok {
  k: Kind;
  s: string;
  i: number;
  /** A JSX tag's own token (name, attribute name, `=`, `>`, closing tag). */
  tag?: boolean;
  /** `<` that opens a JSX element; `jm` is the index of the element's last token. */
  jsx?: boolean;
  jm?: number;
  /** `{` that opens a JSX expression container. */
  jx?: boolean;
  /** Last token of a JSX element that was not inside another element. */
  jend?: boolean;
}

class Fail extends Error {}

const PUNCT = ["...", ">>>=", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>", ":=", "->"].sort((a, b) => b.length - a.length);
/** Identifiers after which a `<` or `/` starts an expression, not an operator. */
const KW_BEFORE_EXPR = new Set(["return", "throw", "case", "else", "do", "in", "of", "typeof", "instanceof", "void", "delete", "new", "await", "yield", "extends", "default"]);

type Frame = { t: "base" | "brace" | "jx" | "hole" | "tag" | "jsx"; name?: string; open?: number; root?: boolean; raw?: boolean; closing?: boolean };

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  const frames: Frame[] = [{ t: "base" }];
  const n = text.length;
  let i = 0;
  let prevSig: Tok | undefined;
  let nlSince = false;
  const top = () => frames[frames.length - 1];
  const push = (k: Kind, s: string, extra?: Partial<Tok>) => {
    const t: Tok = { k, s, i, ...extra };
    toks.push(t);
    i += s.length;
    if (k === "ws") {
      if (s.includes("\n")) nlSince = true;
    } else if (k === "lc") {
      nlSince = true;
    } else if (k !== "bc") {
      prevSig = t;
      nlSince = false;
    }
    return t;
  };
  const isValueEnd = (t: Tok | undefined) => {
    if (!t) return false;
    if (t.k === "id") return !KW_BEFORE_EXPR.has(t.s);
    if (t.k === "num" || t.k === "str" || t.k === "rx") return true;
    if (t.k === "tpl") return t.s.endsWith("`") && !t.s.endsWith("${");
    if (t.k === "p") return t.s === ")" || t.s === "]";
    return false;
  };
  const readTpl = (from: number) => {
    let j = from;
    for (;;) {
      if (j >= n) throw new Fail("unterminated template");
      const c = text[j];
      if (c === "\\") j += 2;
      else if (c === "`") return { end: j + 1, hole: false };
      else if (c === "$" && text[j + 1] === "{") return { end: j + 2, hole: true };
      else j++;
    }
  };
  const endElement = (t: Tok, f: Frame) => {
    toks[f.open!].jm = toks.indexOf(t);
    if (f.root) t.jend = true;
  };

  while (i < n) {
    const f = top();
    const c = text[i];
    if (f.t === "jsx") {
      // Children: text, `{expr}`, nested elements, the closing tag.
      if (f.raw) {
        const end = text.indexOf("</style>", i);
        if (end < 0) throw new Fail("unterminated <style>");
        if (end > i) push("jraw", text.slice(i, end));
      }
      if (text.startsWith("</", i)) {
        push("p", "</", { tag: true });
        const ws1 = /^\s*/.exec(text.slice(i))![0];
        if (ws1) push("ws", ws1);
        const m = /^[A-Za-z_$][\w$:.-]*/.exec(text.slice(i));
        const name = m ? m[0] : "";
        if (m) push("id", name, { tag: true });
        const ws2 = /^\s*/.exec(text.slice(i))![0];
        if (ws2) push("ws", ws2);
        if (text[i] !== ">") throw new Fail("bad closing tag");
        if ((f.name ?? "") !== name) throw new Fail(`</${name}> closes <${f.name}>`);
        const t = push("p", ">", { tag: true });
        frames.pop();
        endElement(t, f);
        continue;
      }
      if (c === "<") {
        const t = push("p", "<", { jsx: true });
        t.jsx = true;
        frames.push({ t: "tag", open: toks.length - 1, root: false });
        continue;
      }
      if (c === "{") {
        push("p", "{", { jx: true });
        frames.push({ t: "jx" });
        continue;
      }
      let j = i;
      while (j < n && text[j] !== "<" && text[j] !== "{") j++;
      push("jt", text.slice(i, j));
      continue;
    }
    if (f.t === "tag") {
      if (/\s/.test(c)) {
        push("ws", /^\s+/.exec(text.slice(i))![0]);
        continue;
      }
      if (f.name === undefined) {
        const m = /^[A-Za-z_$][\w$:.-]*/.exec(text.slice(i));
        f.name = m ? m[0] : "";
        if (m) push("id", m[0], { tag: true });
        continue;
      }
      if (c === ">") {
        push("p", ">", { tag: true });
        frames[frames.length - 1] = { t: "jsx", name: f.name, open: f.open, root: f.root, raw: f.name === "style" };
        continue;
      }
      if (c === "/" && text[i + 1] === ">") {
        const t = push("p", "/>", { tag: true });
        frames.pop();
        endElement(t, f);
        continue;
      }
      if (c === "{") {
        push("p", "{", { jx: true });
        frames.push({ t: "jx" });
        continue;
      }
      if (c === "=") {
        push("p", "=", { tag: true });
        continue;
      }
      if (c === '"' || c === "'") {
        const e = text.indexOf(c, i + 1);
        if (e < 0) throw new Fail("unterminated attribute");
        push("str", text.slice(i, e + 1), { tag: true });
        continue;
      }
      const m = /^[A-Za-z_$][\w$:.-]*/.exec(text.slice(i));
      if (m) {
        push("id", m[0], { tag: true });
        continue;
      }
      throw new Fail(`unexpected ${JSON.stringify(c)} in a tag`);
    }

    // Code.
    if (/\s/.test(c)) {
      push("ws", /^\s+/.exec(text.slice(i))![0]);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      push("lc", text.slice(i, e));
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) throw new Fail("unterminated comment");
      push("bc", text.slice(i, e + 2));
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (j >= n) throw new Fail("unterminated string");
      push("str", text.slice(i, j + 1));
      continue;
    }
    if (c === "`") {
      const r = readTpl(i + 1);
      push("tpl", text.slice(i, r.end));
      if (r.hole) frames.push({ t: "hole" });
      continue;
    }
    if (c === "}") {
      if (f.t === "hole") {
        frames.pop();
        const r = readTpl(i + 1);
        push("tpl", text.slice(i, r.end));
        if (r.hole) frames.push({ t: "hole" });
        continue;
      }
      if (f.t === "base") throw new Fail("unbalanced }");
      frames.pop();
      push("p", "}");
      continue;
    }
    if (c === "{") {
      frames.push({ t: "brace" });
      push("p", "{");
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^(?:0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/.exec(text.slice(i))!;
      push("num", m[0]);
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      push("id", /^[\w$\u0080-￿]+/.exec(text.slice(i))![0]);
      continue;
    }
    if (c === "<" && /[A-Za-z_$>]/.test(text[i + 1] ?? "") && (!isValueEnd(prevSig) || (nlSince && /[A-Za-z_$]/.test(text[i + 1])))) {
      const t = push("p", "<", { jsx: true });
      frames.push({ t: "tag", open: toks.length - 1, root: true });
      void t;
      continue;
    }
    if (c === "/") {
      const value = isValueEnd(prevSig) || (prevSig?.k === "p" && prevSig.s === "}") || prevSig?.jend;
      if (!value) {
        let j = i + 1;
        let cls = false;
        while (j < n && text[j] !== "\n") {
          const d = text[j];
          if (d === "\\") j++;
          else if (d === "[") cls = true;
          else if (d === "]") cls = false;
          else if (d === "/" && !cls) break;
          j++;
        }
        if (text[j] !== "/") throw new Fail("bad regex");
        j++;
        while (j < n && /[a-z]/.test(text[j])) j++;
        push("rx", text.slice(i, j));
        continue;
      }
    }
    const p = PUNCT.find((q) => text.startsWith(q, i));
    push("p", p ?? c);
  }
  if (frames.length !== 1) throw new Fail("unbalanced input");
  return toks;
}

/** Index of each bracket's partner (template holes pair the chunk ending `${` with the one starting `}`). */
function matchBrackets(toks: Tok[]): number[] & { back: number[] } {
  const match = Object.assign(new Array<number>(toks.length).fill(-1), { back: new Array<number>(toks.length).fill(-1) });
  const st: number[] = [];
  const pair = (a: number, b: number) => {
    match[a] = b;
    match[b] = a;
  };
  toks.forEach((t, idx) => {
    if (t.k === "p") {
      if (t.s === "(" || t.s === "[" || t.s === "{") st.push(idx);
      else if (t.s === ")" || t.s === "]" || t.s === "}") {
        const o = st.pop();
        if (o === undefined || toks[o].s !== { ")": "(", "]": "[", "}": "{" }[t.s]) throw new Fail("mismatched bracket");
        pair(o, idx);
      }
    } else if (t.k === "tpl") {
      if (t.s.startsWith("}")) {
        const o = st.pop();
        if (o === undefined) throw new Fail("mismatched template");
        match[o] = idx;
        match.back[idx] = o;
      }
      if (t.s.endsWith("${")) st.push(idx);
    }
  });
  if (st.length) throw new Fail("unclosed bracket");
  return match;
}

const isSig = (t: Tok) => t.k !== "ws" && t.k !== "lc" && t.k !== "bc";
const isP = (t: Tok | undefined, s: string) => !!t && t.k === "p" && t.s === s;
const isId = (t: Tok | undefined, s?: string) => !!t && t.k === "id" && (s === undefined || t.s === s);
const endOf = (t: Tok) => t.i + t.s.length;

/** Exclusive end of a unary operand (prefix operators, a primary, its `.x` / `(…)` / `[…]` tail) starting at j, or -1. */
function unaryEnd(toks: Tok[], match: number[], j: number): number {
  let k = j;
  const skipWs = (x: number) => {
    while (toks[x] && !isSig(toks[x]) && toks[x].k === "ws") x++;
    return x;
  };
  for (;;) {
    const t = toks[k];
    if (!t) return -1;
    if (t.k === "p" && (t.s === "!" || t.s === "-" || t.s === "+" || t.s === "~")) {
      k = skipWs(k + 1);
      continue;
    }
    if (t.k === "id" && (t.s === "await" || t.s === "typeof" || t.s === "void" || t.s === "latest" || t.s === "pre" || t.s === "use")) {
      const nx = skipWs(k + 1);
      if (nx > k + 1 || t.s === "await") {
        k = nx;
        continue;
      }
    }
    if (t.k === "id" && t.s === "pending" && isP(toks[k + 1], "?") && endOf(t) === toks[k + 1].i) {
      k = skipWs(k + 2);
      continue;
    }
    break;
  }
  const t = toks[k];
  if (!t) return -1;
  if (t.k === "id" || t.k === "num" || t.k === "str" || t.k === "rx") k++;
  else if (t.k === "tpl") {
    for (;;) {
      if (!toks[k]) return -1;
      if (toks[k].s.endsWith("`") && !toks[k].s.endsWith("${")) {
        k++;
        break;
      }
      k = match[k];
      if (k < 0) return -1;
    }
  } else if (t.k === "p" && (t.s === "(" || t.s === "[" || t.s === "{")) k = match[k] + 1;
  else if (t.k === "p" && t.jsx && t.jm !== undefined) k = t.jm + 1;
  else return -1;
  for (;;) {
    const a = toks[k];
    if (!a || a.i !== endOf(toks[k - 1])) break;
    if (a.k === "p" && (a.s === "." || a.s === "?.") && toks[k + 1]?.k === "id" && toks[k + 1].i === endOf(a)) k += 2;
    else if (a.k === "p" && (a.s === "(" || a.s === "[")) k = match[k] + 1;
    else if (a.k === "p" && a.s === "?." && (isP(toks[k + 1], "(") || isP(toks[k + 1], "["))) k = match[k + 1] + 1;
    else break;
  }
  return k;
}

// ---------------------------------------------------------------------------------------------------------------
// Mask

type Ctx = "region" | "imp" | "expr";
const CTRL = new Set(["if", "for", "loading", "errored", "portal"]);
const CTRL_TAG: Record<string, string> = { if: "if", for: "for", loading: "lo", errored: "er", portal: "po" };
const RESERVED = new Set(["if", "for", "let", "const", "return", "throw", "try", "import", "export", "else", "while", "do", "switch", "function", "class", "var", "default", "case", "new", "await", "typeof", "delete", "void", "catch", "finally", "break", "continue"]);
const CONT = new Set(["=", "=>", ",", "(", "[", "?", ":", ".", "?.", "+", "-", "*", "/", "%", "&&", "||", "??", "|", "&", "^", "==", "===", "!=", "!==", "<=", ">=", ":=", "->", "...", "!", "~"]);
const KW_CONT = new Set(["in", "of", "instanceof", "typeof", "void", "delete", "new", "await", "else", "do", "extends", "as", "keyof", "is"]);

class Masker {
  private match: number[] & { back: number[] };
  private css: string[] = [];
  private braceCtx = new Map<number, Ctx>();
  /** Each conditional expression's `?` and `:` (rx has no line-leading `?`, a formatter writes it), by token index. */
  private ternary = new Map<number, "Q" | "K">();
  /** Where a conditional's condition starts / its last branch ends (exclusive): `P T(` opens, `)` closes there. */
  private openAt = new Map<number, number>();
  private closeAt = new Map<number, number>();

  constructor(
    private readonly toks: Tok[],
    private readonly P: string,
  ) {
    this.match = matchBrackets(toks);
    this.scanTernary();
  }

  private scanTernary() {
    const toks = this.toks;
    const pend: number[][] = [[]];
    const pairs: [number, number][] = [];
    toks.forEach((t, i) => {
      if (t.tag) return;
      if (t.k === "tpl") {
        if (t.s.startsWith("}")) pend.pop();
        if (t.s.endsWith("${")) pend.push([]);
        return;
      }
      if (t.k !== "p") return;
      const top = pend[pend.length - 1];
      if (t.s === "(" || t.s === "[" || t.s === "{") pend.push([]);
      else if (t.s === ")" || t.s === "]" || t.s === "}") pend.pop();
      else if (t.s === ";") top.length = 0;
      else if (t.s === "?") {
        const n = toks[i + 1];
        const pr = toks[i - 1];
        if (n && isP(n, ":") && n.i === endOf(t)) return;
        if (pr && isId(pr, "pending") && endOf(pr) === t.i) return;
        top.push(i);
      } else if (t.s === ":") {
        const q = top.pop();
        if (q !== undefined) {
          this.ternary.set(q, "Q");
          this.ternary.set(i, "K");
          pairs.push([q, i]);
        }
      }
    });
    for (const [q, k] of pairs) {
      const st = this.condStart(q);
      const en = this.elseEnd(k);
      this.openAt.set(st, (this.openAt.get(st) ?? 0) + 1);
      this.closeAt.set(en, (this.closeAt.get(en) ?? 0) + 1);
    }
  }

  /** First token of the condition whose `?` is at q: back over one expression of the same bracket level. */
  private condStart(q: number): number {
    const toks = this.toks;
    let start = q;
    for (let j = q - 1; j >= 0; j--) {
      const t = toks[j];
      if (!isSig(t)) continue;
      if (start !== q && this.nlBetween(j, start) && !(t.k === "p" && CONT.has(t.s)) && !(t.k === "id" && KW_CONT.has(t.s))) break;
      if (t.k === "p") {
        if (t.jend) {
          // the element's `<`: the nearest earlier `<` whose element ends here
          let k = j;
          while (k >= 0 && !(toks[k].jsx && toks[k].jm === j)) k--;
          if (k < 0) break;
          start = k;
          j = k;
          continue;
        }
        if (t.s === ")" || t.s === "]" || t.s === "}") {
          j = this.match[j];
          start = j;
          continue;
        }
        const pendingQ = t.s === "?" && isId(toks[j - 1], "pending") && endOf(toks[j - 1]) === t.i;
        if (!pendingQ && ["=", ":=", "=>", ",", ";", "(", "[", "{", "?", ":", "..."].includes(t.s)) break;
      } else if (t.k === "tpl") {
        if (t.s.endsWith("${")) break;
        let k = j;
        while (!toks[k].s.startsWith("`")) k = this.match.back[k];
        start = k;
        j = k;
        continue;
      } else if (t.k === "id" && (t.s === "return" || t.s === "case")) break;
      start = j;
    }
    return start;
  }

  /** The index after the last token of the else branch of the conditional whose `:` is at k. */
  private elseEnd(k: number): number {
    const toks = this.toks;
    let end = k + 1;
    let nest = 0;
    let prev = k;
    for (let j = k + 1; j < toks.length; j++) {
      const t = toks[j];
      if (!isSig(t)) continue;
      if (this.nlBetween(prev, j) && !this.ternary.has(j) && !(toks[prev].k === "p" && CONT.has(toks[prev].s)) && !(toks[prev].k === "id" && KW_CONT.has(toks[prev].s))) break;
      if (t.k === "p") {
        if (t.s === ")" || t.s === "]" || t.s === "}") break;
        if (t.s === "(" || t.s === "[" || t.s === "{") {
          j = this.match[j];
        } else if (t.s === "," || t.s === ";") break;
        else if (this.ternary.get(j) === "Q") nest++;
        else if (this.ternary.get(j) === "K") {
          if (nest === 0) break;
          nest--;
        } else if (t.jsx && t.jm !== undefined) j = t.jm;
      } else if (t.k === "id" && t.s === "catch") break;
      else if (t.k === "tpl") {
        if (t.s.startsWith("}")) break;
        while (toks[j].s.endsWith("${")) j = this.match[j];
      }
      prev = j;
      end = j + 1;
    }
    return end;
  }

  run(): { tsx: string; css: string[] } {
    return { tsx: this.range(0, this.toks.length, "region"), css: this.css };
  }

  // -- token helpers
  private sigNext(i: number, hi: number): number {
    for (let k = i + 1; k < hi; k++) if (isSig(this.toks[k])) return k;
    return -1;
  }
  private sigPrev(i: number, lo: number): number {
    for (let k = i - 1; k >= lo; k--) if (isSig(this.toks[k])) return k;
    return -1;
  }
  private nlBetween(a: number, b: number): boolean {
    for (let k = a + 1; k < b; k++) {
      const t = this.toks[k];
      if ((t.k === "ws" && t.s.includes("\n")) || t.k === "lc") return true;
    }
    return false;
  }
  private raw(a: number, b: number): string {
    let s = "";
    for (let k = a; k < b; k++) s += this.toks[k].s;
    return s;
  }
  private stmtStart(i: number, lo: number): boolean {
    const p = this.sigPrev(i, lo);
    if (p < 0) return true;
    const pt = this.toks[p];
    if (pt.jend || isP(pt, ";") || isP(pt, "}")) return true;
    if (!this.nlBetween(p, i)) return false;
    if (pt.k === "p" && CONT.has(pt.s)) return false;
    if (pt.k === "id" && KW_CONT.has(pt.s)) return false;
    return true;
  }
  /** The `=` / `:=` ending a declaration's head, from j (-1 if the statement ends first), and a `key id` clause before it. */
  private scanHead(j: number, hi: number, allowWrite: boolean): { a: number; key?: { at: number; end: number; name: string } } {
    let prev = -1;
    let key: { at: number; end: number; name: string } | undefined;
    for (let k = j; k < hi; k++) {
      const t = this.toks[k];
      if (!isSig(t)) continue;
      if (t.k === "p") {
        if (t.s === "(" || t.s === "[" || t.s === "{") {
          prev = this.match[k];
          k = this.match[k];
          continue;
        }
        if (t.s === "=" || (allowWrite && t.s === ":=")) return { a: k, key };
        if (t.s === ";") return { a: -1, key };
      }
      if (prev >= 0 && this.nlBetween(prev, k)) {
        const pt = this.toks[prev];
        const cont = (pt.k === "p" && ["|", "&", "=>", ":", ",", "?", "<"].includes(pt.s)) || (pt.k === "id" && pt.s === "extends") || (t.k === "p" && ["|", "&", "=>", "?", "."].includes(t.s));
        if (!cont) return { a: -1, key };
      }
      if (isId(t, "key")) {
        const n = this.sigNext(k, hi);
        const e = n >= 0 ? this.sigNext(n, hi) : -1;
        if (n >= 0 && this.toks[n].k === "id" && e >= 0 && (isP(this.toks[e], "=") || (allowWrite && isP(this.toks[e], ":=")))) {
          key = { at: k, end: n + 1, name: this.toks[n].s };
          prev = n;
          k = n;
          continue;
        }
      }
      prev = k;
    }
    return { a: -1, key };
  }

  // -- the walk
  range(lo: number, hi: number, ctx: Ctx): string {
    const toks = this.toks;
    const P = this.P;
    let out = "";
    let i = lo;
    let force = false;
    while (i < hi) {
      const t = toks[i];
      out += this.closers(i) + this.openers(i);
      if (t.k === "ws" || t.k === "lc" || t.k === "bc" || t.k === "str" || t.k === "num" || t.k === "rx" || t.k === "tpl" || t.k === "jt") {
        out += t.s;
        i++;
        continue;
      }
      if (t.k === "jraw") {
        out += `${P}css${this.css.length}`;
        this.css.push(t.s);
        i++;
        continue;
      }
      if (t.tag && !(t.k === "p" && t.jx)) {
        out += t.s;
        i++;
        continue;
      }
      const stmt = ctx !== "expr" && (force || this.stmtStart(i, lo));
      let r: [string, number] | null = null;
      if (t.k === "id") {
        if (stmt && t.s === "export") {
          out += t.s;
          i++;
          force = true;
          continue;
        }
        if (force && t.s === "default") {
          out += t.s;
          i++;
          continue;
        }
        r = this.idHandler(i, lo, hi, ctx, stmt);
      } else if (t.k === "p") {
        r = this.pHandler(i, lo, hi, ctx, stmt);
      }
      force = false;
      if (r) {
        out += r[0];
        i = r[1];
      } else {
        out += t.s;
        i++;
      }
    }
    // a conditional that ends where its bracket does closes here; one that ends at an ordinary token closes at its visit
    if (hi === toks.length || (lo > 0 && this.match[lo - 1] === hi)) out += this.closers(hi);
    return out;
  }

  private closers(i: number): string {
    const n = this.closeAt.get(i);
    if (!n) return "";
    this.closeAt.delete(i);
    return ")".repeat(n);
  }
  private openers(i: number): string {
    const n = this.openAt.get(i);
    if (!n) return "";
    this.openAt.delete(i);
    return `${this.P}T(`.repeat(n);
  }

  private pHandler(i: number, lo: number, hi: number, ctx: Ctx, stmt: boolean): [string, number] | null {
    const t = this.toks[i];
    const P = this.P;
    if (t.s === ":=") return ["|=", i + 1];
    if (t.s === "->") return [`+ ${P}n +`, i + 1];
    if (this.ternary.has(i)) return [",", i + 1];
    if (t.s === "[" && stmt && ctx === "region") {
      const m = this.match[i];
      const a = this.sigNext(m, hi);
      if (a >= 0 && isP(this.toks[a], "=")) return [`var ${this.raw(i, m + 1)}`, m + 1];
    }
    if (t.s === "(" || t.s === "[") {
      const m = this.match[i];
      return [t.s + this.range(i + 1, m, "expr") + this.toks[m].s, m + 1];
    }
    if (t.jsx) {
      const j = t.jm!;
      const prefix = ctx === "region" && stmt ? ";" : "";
      return [prefix + "<" + this.range(i + 1, j + 1, "expr"), j + 1];
    }
    if (t.s !== "{") return null;
    const m = this.match[i];
    const f = this.sigNext(i, m);
    const isCtrl = f >= 0 && this.ctrlAt(f, m);
    if (t.jx) {
      if (isCtrl) {
        const [txt, end] = this.control(f, m, "container");
        if (this.sigNext(end - 1, m) >= 0) throw new Fail("stuff after a control form");
        return ["{" + txt + "}", m + 1];
      }
      return ["{" + this.range(i + 1, m, "expr") + "}", m + 1];
    }
    if (this.braceCtx.has(i)) return ["{" + this.range(i + 1, m, this.braceCtx.get(i)!) + "}", m + 1];
    if (stmt && ctx === "region") {
      if (isCtrl) {
        const [txt, end] = this.control(f, m, "braced");
        if (this.sigNext(end - 1, m) >= 0) throw new Fail("stuff after a control form");
        return [this.sep(i, lo) + txt, m + 1];
      }
      const a = this.sigNext(m, hi);
      if (a >= 0 && isP(this.toks[a], "=")) return [`var ${this.raw(i, m + 1)}`, m + 1];
      return [`${this.sep(i, lo)}${this.P}m(${this.range(i + 1, m, "expr").trim()})`, m + 1];
    }
    const p = this.sigPrev(i, lo);
    const pt = p >= 0 ? this.toks[p] : undefined;
    const block = (pt && ((pt.k === "p" && (pt.s === ")" || pt.s === "=>")) || (pt.k === "id" && ["else", "try", "finally", "do"].includes(pt.s)))) || (stmt && ctx === "imp");
    return ["{" + this.range(i + 1, m, block ? "imp" : "expr") + "}", m + 1];
  }

  /** `;` between a markup statement and a statement that follows it on the same line. */
  private sep(i: number, lo: number): string {
    const p = this.sigPrev(i, lo);
    return p >= 0 && !this.nlBetween(p, i) && !isP(this.toks[p], ";") ? ";" : "";
  }

  private ctrlAt(f: number, hi: number): boolean {
    const t = this.toks[f];
    if (t.k !== "id" || !CTRL.has(t.s)) return false;
    const n = this.sigNext(f, hi);
    const nt = n >= 0 ? this.toks[n] : undefined;
    if (t.s === "if") return true;
    if (t.s === "for") {
      const n2 = n >= 0 ? this.sigNext(n, hi) : -1;
      return isId(nt) && isId(this.toks[n2], "in");
    }
    if (t.s === "loading") return isId(nt, "fallback") || isId(nt, "on");
    if (t.s === "errored") return isId(nt, "fallback");
    return isId(nt, "to");
  }

  private block(prevEnd: number, hi: number): [number, number] {
    const s = this.sigNext(prevEnd - 1, hi);
    for (let k = prevEnd; k < s; k++) if (this.toks[k].k === "lc" || this.toks[k].k === "bc") throw new Fail("comment between blocks");
    if (s < 0 || !isP(this.toks[s], "{")) throw new Fail("expected a block");
    return [s, this.match[s]];
  }
  private findBodyOpen(from: number, hi: number): number {
    for (let k = from; k < hi; k++) {
      const t = this.toks[k];
      if (t.k !== "p") continue;
      if (t.s === "(" || t.s === "[") k = this.match[k];
      else if (t.s === "{") return k;
    }
    throw new Fail("no block");
  }
  private arrow(params: string, open: number): string {
    return `(${params}) => {${this.range(open + 1, this.match[open], "region")}}`;
  }

  /** A control form starting at f (the `if` / `for` / … token) as a tagged call; returns it and the index after it. */
  private control(f: number, hi: number, form: "container" | "braced" | "bare", tagOverride?: string): [string, number] {
    const toks = this.toks;
    const kw = toks[f].s;
    const tag = this.P + (tagOverride ?? CTRL_TAG[kw] + (form === "bare" ? "_s" : form === "braced" ? "_b" : ""));
    if (kw === "if") {
      const open = this.findBodyOpen(f + 1, hi);
      const cond = this.range(f + 1, open, "expr").trim();
      let end = this.match[open] + 1;
      let call = `${tag}(${cond}, ${this.arrow("", open)}`;
      const e = this.sigNext(end - 1, hi);
      if (e >= 0 && isId(toks[e], "else")) {
        const e2 = this.sigNext(e, hi);
        if (e2 >= 0 && isP(toks[e2], "{")) {
          call += `, ${this.arrow("", e2)}`;
          end = this.match[e2] + 1;
        } else if (e2 >= 0 && isId(toks[e2], "if")) {
          const [sub, next] = this.control(e2, hi, "bare", "ei");
          call += `, ${sub}`;
          end = next;
        } else throw new Fail("bad else");
      }
      return [call + ")", end];
    }
    if (kw === "for") {
      const nameIdx = this.sigNext(f, hi);
      const inIdx = this.sigNext(nameIdx, hi);
      const open = this.findBodyOpen(inIdx + 1, hi);
      const expr = this.range(inIdx + 1, open, "expr").trim();
      return [`${tag}(${expr}, ${this.arrow(toks[nameIdx].s, open)})`, this.match[open] + 1];
    }
    if (kw === "loading") {
      let k = this.sigNext(f, hi);
      let on = "";
      if (isId(toks[k], "on")) {
        const par = this.sigNext(k, hi);
        if (!isP(toks[par], "(")) throw new Fail("loading on");
        on = this.range(par + 1, this.match[par], "expr").trim() + ", ";
        k = this.sigNext(this.match[par], hi);
      }
      if (!isId(toks[k], "fallback")) throw new Fail("loading fallback");
      const [a0, a1] = this.block(k + 1, hi);
      const [b0, b1] = this.block(a1 + 1, hi);
      return [`${tag}(${on}${this.arrow("", a0)}, ${this.arrow("", b0)})`, b1 + 1];
    }
    if (kw === "errored") {
      const k = this.sigNext(f, hi);
      let at = k + 1;
      let params = "";
      const par = this.sigNext(k, hi);
      if (isP(toks[par], "(")) {
        params = this.range(par + 1, this.match[par], "expr").trim();
        at = this.match[par] + 1;
      }
      const [a0, a1] = this.block(at, hi);
      const [b0, b1] = this.block(a1 + 1, hi);
      return [`${tag}(${this.arrow(params, a0)}, ${this.arrow("", b0)})`, b1 + 1];
    }
    // portal to(e) { … }
    const k = this.sigNext(f, hi);
    const par = this.sigNext(k, hi);
    if (!isP(toks[par], "(")) throw new Fail("portal to");
    const [b0, b1] = this.block(this.match[par] + 1, hi);
    return [`${tag}(${this.range(par + 1, this.match[par], "expr").trim()}, ${this.arrow("", b0)})`, b1 + 1];
  }

  private idHandler(i: number, lo: number, hi: number, ctx: Ctx, stmt: boolean): [string, number] | null {
    const toks = this.toks;
    const P = this.P;
    const t = toks[i];
    const s = t.s;
    const n1 = this.sigNext(i, hi);
    const nt = n1 >= 0 ? toks[n1] : undefined;
    const adj = (k: number) => toks[k] && toks[k].i === endOf(toks[k - 1]);
    const prevI = this.sigPrev(i, 0);
    const prevT = prevI >= 0 ? toks[prevI] : undefined;
    const afterDot = isP(prevT, ".") || isP(prevT, "?.");

    // ---- expression-level forms
    if (!afterDot) {
      if (s === "pending" && isP(toks[i + 1], "?") && adj(i + 1) && toks[i + 2]?.k === "ws") return this.unary(this.sigNext(i + 1, hi), "q");
      if ((s === "latest" || s === "pre") && toks[i + 1]?.k === "ws" && nt && !isP(nt, "=") && !isP(nt, ":=") && (nt.k === "id" || nt.k === "num" || nt.k === "str" || nt.k === "tpl" || isP(nt, "(") || isP(nt, "["))) {
        if (!(prevT && prevT.k === "id" && !KW_BEFORE_EXPR.has(prevT.s) && !this.nlBetween(prevI, i))) return this.unary(n1, s === "latest" ? "l" : "e");
      }
      if (s === "use" && toks[i + 1]?.k === "ws" && nt && nt.k === "id" && !KW_BEFORE_EXPR.has(nt.s) && !(prevT && prevT.k === "id" && !KW_BEFORE_EXPR.has(prevT.s) && !this.nlBetween(prevI, i))) return this.unary(n1, "u");
      if (s === "await" && isP(toks[i + 1], "*") && adj(i + 1)) {
        return this.unary(this.sigNext(i + 1, hi), "s");
      }
      if (s === "throw" && prevT && prevT.k === "p" && ["?", ":", "=>", "||", "&&", "??", "=", "(", ","].includes(prevT.s)) return this.unary(n1, "t");
      if (s === "catch") {
        const stmtCatch = isP(prevT, "}") && isId(toks[this.sigPrev(this.match[prevI], lo)], "try");
        if (!stmtCatch && nt) {
          if (isP(nt, "(")) return this.catchAlt(i, `? ${P}c :`, hi);
          if (isP(nt, "=>")) return this.catchAlt(i, `? ${P}c0 : ()`, hi);
        }
      }
      if (s === "draft" && isP(toks[i + 1], "(") && adj(i + 1)) {
        const m = this.match[i + 1];
        const b = this.sigNext(m, hi);
        if (b >= 0 && isP(toks[b], "{")) {
          const body = this.range(b + 1, this.match[b], "imp");
          return [`${P}d(${this.range(i + 2, m, "expr")}, () => {${body}})`, this.match[b] + 1];
        }
      }
    }
    if (s === "ref" && nt && nt.k === "id" && (isP(prevT, "(") || isP(prevT, ",")) && toks[i + 1].k === "ws") return [`${nt.s}${P}r`, n1 + 1];

    if (!stmt) return null;

    // ---- statements
    switch (s) {
      case "import":
        return this.importStmt(i, hi);
      case "source":
      case "deferred":
      case "context":
      case "provide": {
        if (!nt || nt.k !== "id") break;
        return this.declLike(i, hi, s, n1);
      }
      case "effect": {
        if (!isP(nt, "(")) break;
        const m = this.match[n1];
        return [`while ([${this.range(n1 + 1, m, "expr")}])`, m + 1];
      }
      case "component": {
        if (!nt || nt.k !== "id") break;
        const par = this.sigNext(n1, hi);
        if (!isP(toks[par], "(")) break;
        const b = this.sigNext(this.match[par], hi);
        if (!isP(toks[b], "{")) throw new Fail("component without a body");
        this.braceCtx.set(b, "region");
        return [`function ${nt.s}${P}c`, par];
      }
      case "fn": {
        if (!nt || nt.k !== "id") break;
        const par = this.sigNext(n1, hi);
        if (!isP(toks[par], "(")) throw new Fail("fn: " + (toks[par]?.s ?? ""));
        let k = this.sigNext(this.match[par], hi);
        // return type up to `=>` or the body's `{`
        let isArrow = false;
        for (; k >= 0 && k < hi; k = this.sigNext(k, hi)) {
          const tk = toks[k];
          if (isP(tk, "=>")) {
            isArrow = true;
            break;
          }
          if (isP(tk, "{")) {
            const pk = this.sigPrev(k, lo);
            if (isP(toks[pk], ":")) {
              k = this.match[k];
              continue;
            }
            break;
          }
          if (tk.k === "p" && (tk.s === "(" || tk.s === "[")) k = this.match[k];
        }
        if (k < 0) throw new Fail("fn without a body");
        if (isArrow) return [`const ${nt.s}${P}f = `, par];
        this.braceCtx.set(k, "region");
        return [`function ${nt.s}${P}f`, par];
      }
      case "server": {
        if (!isId(nt, "fn")) break;
        const nm = this.sigNext(n1, hi);
        const par = this.sigNext(nm, hi);
        if (!isP(toks[par], "(")) throw new Fail("server fn");
        const b = this.sigNext(this.match[par], hi);
        if (!isP(toks[b], "{")) throw new Fail("server fn body");
        this.braceCtx.set(b, "imp");
        return [`function ${toks[nm].s}${P}v`, par];
      }
      case "action": {
        if (isP(nt, "{")) {
          this.braceCtx.set(n1, "imp");
          return [`${P}k:`, i + 1];
        }
        if (!nt || nt.k !== "id") break;
        const par = this.sigNext(n1, hi);
        if (!isP(toks[par], "(")) break;
        const b = this.sigNext(this.match[par], hi);
        if (!isP(toks[b], "{")) throw new Fail("action body");
        this.braceCtx.set(b, "imp");
        return [`function ${nt.s}${P}a`, par];
      }
      case "error": {
        if (!nt || nt.k !== "id") break;
        const after = this.sigNext(n1, hi);
        const at = toks[after];
        if (isP(at, "(")) {
          const m = this.match[after];
          const arrow = this.sigNext(m, hi);
          if (isP(toks[arrow], "=>")) return [`const ${nt.s}${P}e = `, after];
          return [`function ${nt.s}${P}e2${this.raw(after, m + 1)} {}`, m + 1];
        }
        if (isP(at, "=>")) return [`const ${nt.s}${P}e1 = ()`, n1 + 1];
        return [`function ${nt.s}${P}e3() {}`, n1 + 1];
      }
      case "guess":
      case "optimistic":
        if (nt && nt.k === "id" && toks[i + 1].k === "ws") return [`${P}${s === "guess" ? "g" : "o"}:`, i + 1];
        break;
      case "refresh":
      case "affects":
        if (nt && nt.k === "id" && toks[i + 1].k === "ws" && !this.nlBetween(i, n1)) return [`${P}${s === "refresh" ? "r" : "h"}:`, i + 1];
        break;
    }
    if (ctx === "region") {
      if (CTRL.has(s) && this.ctrlAt(i, hi)) {
        const [txt, end] = this.control(i, hi, "bare");
        return [this.sep(i, lo) + txt, end];
      }
      const eq = this.equation(i, hi);
      if (eq) return eq;
    }
    return null;
  }

  /** `catch (x) => alt`: an alt that opens with `{` is an object literal, which a TSX arrow only takes in parentheses. */
  private catchAlt(i: number, head: string, hi: number): [string, number] {
    const toks = this.toks;
    let a = this.sigNext(i, hi);
    if (isP(toks[a], "(")) a = this.sigNext(this.match[a], hi);
    if (isP(toks[a], "=>")) {
      const b = this.sigNext(a, hi);
      if (isP(toks[b], "{")) {
        const m = this.match[b];
        return [head + this.range(i + 1, a + 1, "expr") + " (" + this.range(b, m + 1, "expr") + ")", m + 1];
      }
    }
    return [head, i + 1];
  }

  private unary(operandStart: number, tag: string): [string, number] {
    if (operandStart < 0) throw new Fail("operator without operand");
    const e = unaryEnd(this.toks, this.match, operandStart);
    if (e < 0) throw new Fail("operand");
    return [`${this.P}${tag}(${this.range(operandStart, e, "expr")})`, e];
  }

  private importStmt(i: number, hi: number): [string, number] | null {
    const toks = this.toks;
    const n1 = this.sigNext(i, hi);
    if (!isId(toks[n1], "pure")) {
      return this.maybeFails(i, hi, null);
    }
    const n2 = this.sigNext(n1, hi);
    if (isP(toks[n2], "{")) return this.maybeFails(i, hi, [`import ${this.P}p,`, n1 + 1]);
    if (toks[n2]?.k === "id" && !isId(toks[n2], "from")) return this.maybeFails(i, hi, [`import ${toks[n2].s}${this.P}p`, n2 + 1]);
    throw new Fail("import pure form");
  }
  /** `… from "x" fails A | B`: the clause becomes a labelled statement on the next line. */
  private maybeFails(i: number, hi: number, head: [string, number] | null): [string, number] | null {
    const toks = this.toks;
    let k = i;
    let from = -1;
    for (; k < hi; k++) {
      if (isId(toks[k], "from")) from = k;
      if (toks[k].k === "str" && from >= 0) break;
      if (isP(toks[k], ";")) return head;
    }
    if (k >= hi) return head;
    const f = this.sigNext(k, hi);
    if (f < 0 || !isId(toks[f], "fails") || this.nlBetween(k, f)) return head;
    // the rest of the line
    let e = f + 1;
    while (e < hi && !(toks[e].k === "ws" && toks[e].s.includes("\n")) && toks[e].k !== "lc") e++;
    const classes = this.raw(f + 1, e).trim();
    const start = head ? head[1] : i;
    return [(head ? head[0] : "") + this.range(start, k + 1, "expr") + `\n${this.P}z: ${classes}`, e];
  }

  private declLike(i: number, hi: number, kw: string, nameIdx: number): [string, number] {
    const toks = this.toks;
    const P = this.P;
    const name = toks[nameIdx].s;
    const afterName = nameIdx + 1;
    const { a, key } = this.scanHead(afterName, hi, kw === "source");
    let flag = kw === "source" ? "S" : kw === "deferred" ? "d" : kw === "context" ? "x" : "p";
    if (kw === "source" && a >= 0 && toks[a].s === ":=") flag = "s";
    const head = `let ${name}${P}${flag}${key ? "$" + key.name : ""}`;
    if (a >= 0) return [head + (key ? this.raw(afterName, key.at) + this.raw(key.end, a) : this.raw(afterName, a)) + "=", a + 1];
    // no initializer: the type runs to the end of the statement
    let last = afterName - 1;
    let prev = -1;
    for (let e = afterName; e < hi; e++) {
      const t = toks[e];
      if (!isSig(t)) continue;
      if (prev >= 0 && this.nlBetween(prev, e)) {
        const pt = toks[prev];
        const cont = (pt.k === "p" && ["|", "&", "=>", ":", ",", "?", "<"].includes(pt.s)) || (t.k === "p" && ["|", "&", "=>", "?", "."].includes(t.s));
        if (!cont) break;
      }
      if (isP(t, ";")) break;
      if (t.k === "p" && (t.s === "(" || t.s === "[" || t.s === "{")) e = this.match[e];
      prev = e;
      last = e;
    }
    return [head + this.raw(afterName, last + 1), last + 1];
  }

  private equation(i: number, hi: number): [string, number] | null {
    const toks = this.toks;
    const P = this.P;
    const t = toks[i];
    if (t.k !== "id" || RESERVED.has(t.s)) return null;
    const k = this.sigNext(i, hi);
    if (k < 0) return null;
    // `x = e`, `x: T = e`, `x key k = e`, `x: T key k = e`
    if (!isP(toks[k], "=") && !isP(toks[k], ":") && !isId(toks[k], "key")) return null;
    const { a, key } = this.scanHead(i + 1, hi, false);
    if (a < 0) return null;
    if (key) return [`let ${t.s}${P}q$${key.name}${this.raw(i + 1, key.at)}${this.raw(key.end, a)}=`, a + 1];
    return [`var ${t.s}${this.raw(i + 1, a)}=`, a + 1];
  }
}

export function maskRx(text: string): Masked | null {
  try {
    const toks = tokenize(text);
    for (const t of toks) {
      if (t.k === "id" && !t.tag && (t.s === "var" || t.s === "while")) return null;
      if (t.k === "p" && !t.tag && (t.s === "|=")) return null;
    }
    let n = 0;
    while (text.includes(`__rx${n}`)) n++;
    const P = `__rx${n}`;
    const { tsx, css } = new Masker(toks, P).run();
    return { tsx, unmask: (formatted) => unmask(formatted, P, css) };
  } catch (e) {
    if (e instanceof Fail) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Unmask

/** Text with the ranges that must keep their line breaks and indentation as they are (templates, CSS). */
class B {
  text = "";
  prot: [number, number][] = [];
  add(s: string, protect = false) {
    if (protect && s.includes("\n")) this.prot.push([this.text.length, this.text.length + s.length]);
    this.text += s;
  }
  addB(o: B) {
    const off = this.text.length;
    for (const [a, b] of o.prot) this.prot.push([a + off, b + off]);
    this.text += o.text;
  }
  trimEnd() {
    this.text = this.text.replace(/\s+$/, "");
  }
}

function reindent(b: B, delta: number): B {
  if (!delta) return b;
  const out = new B();
  const adjust: [number, number][] = [];
  let o = "";
  let last = 0;
  const inProt = (p: number) => b.prot.some(([s, e]) => p >= s && p < e);
  let cum = 0;
  for (let p = b.text.indexOf("\n"); p >= 0; p = b.text.indexOf("\n", p + 1)) {
    if (inProt(p)) continue;
    let q = p + 1;
    while (q < b.text.length && (b.text[q] === " " || b.text[q] === "\t")) q++;
    if (q >= b.text.length || b.text[q] === "\n") continue;
    const old = q - p - 1;
    const now = Math.max(0, old + delta);
    o += b.text.slice(last, p + 1) + " ".repeat(now);
    last = q;
    cum += now - old;
    adjust.push([q, cum]);
  }
  o += b.text.slice(last);
  out.text = o;
  const map = (pos: number) => {
    let d = 0;
    for (const [q, c] of adjust) if (q <= pos) d = c;
    return pos + d;
  };
  out.prot = b.prot.map(([s, e]) => [map(s), map(e)]);
  return out;
}

class Unmasker {
  private toks: Tok[];
  private match: number[] & { back: number[] };
  private skip = new Set<number>();
  private eqSwap = new Map<number, string>();
  private tagRe: RegExp;
  private inHole: boolean[];

  constructor(
    private readonly src: string,
    private readonly P: string,
    private readonly css: string[],
  ) {
    this.toks = tokenize(src);
    this.match = matchBrackets(this.toks);
    this.tagRe = new RegExp(`^(.+?)${P}([A-Za-z]\\d?)(?:\\$(.+))?$`);
    let depth = 0;
    this.inHole = this.toks.map((t) => {
      if (t.k === "tpl" && t.s.startsWith("}")) depth--;
      const d = depth > 0;
      if (t.k === "tpl" && t.s.endsWith("${")) depth++;
      return d;
    });
    this.prescan();
  }

  private sigNext(i: number, hi = this.toks.length): number {
    for (let k = i + 1; k < hi; k++) if (isSig(this.toks[k])) return k;
    return -1;
  }
  private sigPrev(i: number): number {
    for (let k = i - 1; k >= 0; k--) if (isSig(this.toks[k])) return k;
    return -1;
  }
  private nlBetween2(a: number, b: number): boolean {
    for (let k = a + 1; k < b; k++) if (this.toks[k].k === "ws" && this.toks[k].s.includes("\n")) return true;
    return false;
  }
  private tagOf(t: Tok | undefined): string | null {
    return t && t.k === "id" && t.s.startsWith(this.P) ? t.s.slice(this.P.length) : null;
  }

  /** `(await x) | P n | v` and `(await x) ? P c : f`: the formatter parenthesised the `await`; drop those parens. */
  private prescan() {
    const toks = this.toks;
    const P = this.P;
    const dropAwaitParens = (before: number) => {
      const p = this.sigPrev(before);
      if (p >= 0 && isP(toks[p], ")")) {
        const o = this.match[p];
        if (isId(toks[this.sigNext(o)], "await")) {
          this.skip.add(o);
          this.skip.add(p);
        }
      }
    };
    toks.forEach((t, idx) => {
      if (t.k === "p" && t.s === "+") {
        const a = this.sigNext(idx);
        if (a >= 0 && /^n$/.test(this.tagOf(toks[a]) ?? "") && isP(toks[this.sigNext(a)], "+")) dropAwaitParens(idx);
      }
      if (t.k === "p" && t.s === "?") {
        const a = this.sigNext(idx);
        if (a >= 0 && (toks[a].s === `${P}c` || toks[a].s === `${P}c0`) && isP(toks[this.sigNext(a)], ":")) dropAwaitParens(idx);
      }
    });
  }

  private indentAt(pos: number): number {
    const ls = this.src.lastIndexOf("\n", pos - 1) + 1;
    let n = 0;
    while (this.src[ls + n] === " ") n++;
    return n;
  }

  private splitArgs(open: number): [number, number][] {
    const close = this.match[open];
    const args: [number, number][] = [];
    let start = open + 1;
    for (let k = open + 1; k < close; k++) {
      const t = this.toks[k];
      if (t.k === "p" && (t.s === "(" || t.s === "[" || t.s === "{")) k = this.match[k];
      else if (t.k === "tpl" && t.s.endsWith("${")) k = this.match[k];
      else if (isP(t, ",")) {
        args.push([start, k]);
        start = k + 1;
      }
    }
    if (this.toks.slice(start, close).some(isSig)) args.push([start, close]);
    return args;
  }

  all(): string {
    return this.walk(0, this.toks.length).text;
  }

  walk(lo: number, hi: number): B {
    const toks = this.toks;
    const P = this.P;
    const out = new B();
    let i = lo;
    while (i < hi) {
      const t = toks[i];
      if (this.skip.has(i)) {
        i++;
        continue;
      }
      switch (t.k) {
        case "tpl":
          out.add(t.s, true);
          i++;
          continue;
        case "jraw": {
          const m = new RegExp(`^\\s*${P}css(\\d+)\\s*$`).exec(t.s);
          out.add(m ? this.css[+m[1]] : t.s, true);
          i++;
          continue;
        }
        case "id": {
          const r = this.idTok(i, hi, out);
          if (r >= 0) {
            i = r;
            continue;
          }
          break;
        }
        case "p": {
          const r = this.pTok(i, hi, out);
          if (r >= 0) {
            i = r;
            continue;
          }
          break;
        }
      }
      out.add(t.s);
      i++;
    }
    return out;
  }

  private pTok(i: number, hi: number, out: B): number {
    const toks = this.toks;
    const P = this.P;
    const t = toks[i];
    if (t.s === "|=") {
      out.add(":=");
      return i + 1;
    }
    if (t.s === ";") {
      // a `;` the formatter put at the start of a line to protect the statement after it
      const prev = toks[i - 1];
      if (i === 0 || (prev.k === "ws" && prev.s.includes("\n")) || prev.k === "lc") return i + 1;
      return -1;
    }
    if (this.eqSwap.has(i)) {
      out.add(this.eqSwap.get(i)!);
      return i + 1;
    }
    if (t.s === "+") {
      const a = this.sigNext(i);
      const sym = { n: "->" }[this.tagOf(toks[a]) ?? ""];
      const b = a >= 0 ? this.sigNext(a) : -1;
      if (sym && isP(toks[b], "+")) {
        out.trimEnd();
        out.add(" " + sym);
        return b + 1;
      }
    }
    if ((t.s === "." || t.s === "?.") && toks[i - 1]?.k === "ws" && toks[i - 1].s.includes("\n")) {
      // a member chain the formatter broke before its `.`: rx has no such continuation line
      out.trimEnd();
      out.add(t.s);
      return i + 1;
    }
    if (t.s === "?") {
      const a = this.sigNext(i);
      const tg = this.tagOf(toks[a]);
      if ((tg === "c" || tg === "c0") && isP(toks[this.sigNext(a)], ":")) {
        const colon = this.sigNext(a);
        out.trimEnd();
        out.add(" catch");
        if (tg === "c0") {
          const o = this.sigNext(colon);
          const c = this.sigNext(o);
          if (isP(toks[o], "(") && isP(toks[c], ")")) return c + 1;
        }
        // `catch e => …`: the formatter dropped the parentheses `catch` needs
        const nx = this.sigNext(colon);
        if (toks[nx]?.k === "id" && isP(toks[this.sigNext(nx)], "=>")) {
          out.add(" (" + toks[nx].s + ")");
          return nx + 1;
        }
        return colon + 1;
      }
    }
    return -1;
  }

  private nameTag(t: Tok | undefined): { name: string; flag: string; key?: string } | null {
    if (!t || t.k !== "id" || !t.s.includes(this.P)) return null;
    const m = this.tagRe.exec(t.s);
    return m ? { name: m[1], flag: m[2], key: m[3] } : null;
  }

  private idTok(i: number, hi: number, out: B): number {
    const toks = this.toks;
    const P = this.P;
    const t = toks[i];
    const s = t.s;
    const n1 = this.sigNext(i, hi);

    if (s === "var") {
      let k = i + 1;
      if (toks[k]?.k === "ws") k++;
      return k;
    }
    if (s === "while") {
      const o = n1;
      if (!isP(toks[o], "(")) throw new Fail("while");
      const c = this.match[o];
      const lb = this.sigNext(o, c);
      if (!isP(toks[lb], "[") || this.sigNext(this.match[lb], c) >= 0) throw new Fail("while([");
      const args = this.walk(lb + 1, this.match[lb]);
      args.trimEnd();
      args.text = args.text.replace(/^\s+/, "").replace(/,$/, "");
      out.add("effect (");
      out.addB(args);
      out.add(")");
      return c + 1;
    }
    if (s === "import") {
      const a = toks[n1];
      if (a && a.s === `${P}p` && isP(toks[this.sigNext(n1)], ",")) {
        out.add("import pure");
        return this.sigNext(n1) + 1;
      }
      const nt = this.nameTag(a);
      if (nt && nt.flag === "p") {
        out.add(`import pure ${nt.name}`);
        return n1 + 1;
      }
      return -1;
    }
    if (s === "let") {
      const nt = this.nameTag(toks[n1]);
      if (!nt || !"sSdxpq".includes(nt.flag)) return -1;
      const kw = { s: "source ", S: "source ", d: "deferred ", x: "context ", p: "provide ", q: "" }[nt.flag]!;
      out.add(kw + nt.name);
      if (nt.flag === "s" || nt.key) {
        for (let k = n1 + 1; k < hi; k++) {
          const tk = toks[k];
          if (tk.k === "p" && (tk.s === "(" || tk.s === "[" || tk.s === "{")) k = this.match[k];
          else if (isP(tk, "=")) {
            this.eqSwap.set(k, (nt.key ? `key ${nt.key} ` : "") + (nt.flag === "s" ? ":=" : "="));
            break;
          }
        }
      }
      return n1 + 1;
    }
    if (s === "const") {
      const nt = this.nameTag(toks[n1]);
      if (!nt || !"fe".includes(nt.flag[0])) return -1;
      if (nt.flag === "f" || nt.flag === "e") {
        // const N = (params) …  →  fn N(params) …
        const eq = this.sigNext(n1);
        const par = this.sigNext(eq);
        out.add((nt.flag === "f" ? "fn " : "error ") + nt.name);
        return par;
      }
      if (nt.flag === "e1") {
        const eq = this.sigNext(n1);
        const o = this.sigNext(eq);
        const c = this.sigNext(o);
        out.add("error " + nt.name);
        return c + 1;
      }
      return -1;
    }
    if (s === "function") {
      const nt = this.nameTag(toks[n1]);
      if (!nt) return -1;
      const kw: Record<string, string> = { c: "component ", f: "fn ", a: "action ", v: "server fn ", e2: "error ", e3: "error " };
      if (!kw[nt.flag]) return -1;
      out.add(kw[nt.flag] + nt.name);
      if (nt.flag === "e3") {
        const o = this.sigNext(n1);
        const bo = this.sigNext(this.match[o]);
        return this.match[bo] + 1;
      }
      if (nt.flag === "e2") {
        const o = this.sigNext(n1);
        const c = this.match[o];
        out.addB(this.walk(o, c + 1));
        const bo = this.sigNext(c);
        return this.match[bo] + 1;
      }
      return n1 + 1;
    }
    // ---- standalone tags
    if (s.startsWith(P) && !s.slice(P.length).includes("$")) return this.tag(i, hi, out, s.slice(P.length));
    const nt = this.nameTag(t);
    if (nt && nt.flag === "r" && !nt.key) {
      out.add(`ref ${nt.name}`);
      return i + 1;
    }
    if (nt) throw new Fail(`stray tag ${s}`);
    return -1;
  }

  private tag(i: number, hi: number, out: B, tg: string): number {
    const toks = this.toks;
    const n1 = this.sigNext(i, hi);
    const label: Record<string, string> = { g: "guess", o: "optimistic", r: "refresh", h: "affects", k: "action" };
    if (label[tg]) {
      if (!isP(toks[n1], ":")) throw new Fail("label");
      out.add(label[tg]);
      return n1 + 1;
    }
    if (tg === "z") {
      if (!isP(toks[n1], ":")) throw new Fail("fails label");
      let e = n1 + 1;
      while (e < toks.length && !(toks[e].k === "ws" && toks[e].s.includes("\n"))) e++;
      out.trimEnd();
      out.add(" fails " + this.walk(n1 + 1, e).text.trim());
      return e;
    }
    const unary: Record<string, string> = { q: "pending? ", l: "latest ", e: "pre ", u: "use ", s: "await* ", t: "throw " };
    if (unary[tg]) {
      if (!isP(toks[n1], "(")) throw new Fail("unary call");
      const close = this.match[n1];
      const args = this.splitArgs(n1);
      if (args.length !== 1) throw new Fail("unary args");
      let inner = this.walk(args[0][0], args[0][1]);
      inner.text = inner.text.trim();
      // the operand must stay one unary expression
      let simple = false;
      try {
        const it = tokenize(inner.text);
        simple = unaryEnd(it, matchBrackets(it), 0) === it.length;
      } catch {
        simple = false;
      }
      const body = new B();
      body.add(unary[tg]);
      if (simple) body.addB(inner);
      else {
        body.add("(");
        body.addB(inner);
        body.add(")");
      }
      const after = toks[close + 1];
      const postfix = after && after.i === endOf(toks[close]) && ((after.k === "p" && [".", "?.", "(", "["].includes(after.s)) || after.k === "tpl");
      if (postfix) {
        out.add("(");
        out.addB(body);
        out.add(")");
      } else out.addB(body);
      return close + 1;
    }
    if (tg === "T") {
      const args = this.splitArgs(n1);
      if (args.length !== 3) throw new Fail("conditional args");
      const parts = args.map(([x, y]) => this.walk(x, y));
      for (const b of parts) b.text = b.text.replace(/^\s+|\s+$/g, "");
      // `catch` is looser than `?:`: a branch that ends in one needs the parentheses the formatter dropped
      args.forEach(([x, y], q) => {
        for (let k = x; k < y; k++) {
          const tk = toks[k];
          if (tk.k === "p" && (tk.s === "(" || tk.s === "[" || tk.s === "{")) k = this.match[k];
          else if (tk.k === "id" && (this.tagOf(tk) === "c" || this.tagOf(tk) === "c0")) {
            parts[q].text = "(" + parts[q].text + ")";
            parts[q].prot = parts[q].prot.map(([a, b]) => [a + 1, b + 1] as [number, number]);
            break;
          }
        }
      });
      // a conditional that is an operand (`(c ? a : b) ?? d`, `!(c ? a : b)`) keeps the parentheses the formatter dropped
      const pv = this.sigPrev(i);
      const nx = this.sigNext(this.match[n1]);
      const pt = toks[pv];
      const nt = toks[nx];
      const before = !pt || (pt.k === "p" && ["=", "|=", "(", "[", "{", ",", "=>", ":", ";", "?"].includes(pt.s)) || (pt.k === "id" && pt.s === "return") || (pt.k === "tpl" && pt.s.endsWith("${")) || (pt.k === "id" && pt.s === "var");
      const after = !nt || (nt.k === "p" && [")", "]", "}", ",", ";", ":"].includes(nt.s)) || (nt.k === "tpl" && nt.s.startsWith("}")) || (this.nlBetween2(this.match[n1], nx) && !(nt.k === "p" && [".", "?.", "(", "[", "+", "-", "*", "/", "%", "&&", "||", "??", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "|", "&", "?", "="].includes(nt.s)));
      const wrap = !(before && after);
      if (wrap) out.add("(");
      const lineStart = this.src.lastIndexOf("\n", toks[i].i - 1) + 1;
      const col = toks[i].i - lineStart + (wrap ? 1 : 0);
      const ci = this.indentAt(toks[i].i);
      const flat = this.inHole[i] || parts.every((b) => !b.text.includes("\n"));
      const joined = `${parts[0].text} ? ${parts[1].text} : ${parts[2].text}`;
      if (flat && (this.inHole[i] || col + joined.length <= 80)) {
        for (let q = 0; q < 3; q++) {
          if (q) out.add(q === 1 ? " ? " : " : ");
          out.addB(parts[q]);
        }
      } else {
        // trailing operators: rx has no line that starts with `?` or `:`
        const ind = "\n" + " ".repeat(ci + 2);
        out.addB(parts[0]);
        out.add(" ?" + ind);
        out.addB(parts[1]);
        out.add(" :" + ind);
        out.addB(parts[2]);
      }
      if (wrap) out.add(")");
      return this.match[n1] + 1;
    }
    if (tg === "m") {
      if (!isP(toks[n1], "(")) throw new Fail("reader");
      const inner = this.walk(n1 + 1, this.match[n1]);
      inner.text = inner.text.trim().replace(/,$/, "");
      out.add("{");
      out.addB(inner);
      out.add("}");
      return this.match[n1] + 1;
    }
    if (tg === "d") {
      const args = this.splitArgs(n1);
      if (args.length !== 2) throw new Fail("draft args");
      const e = this.walk(args[0][0], args[0][1]);
      e.text = e.text.trim();
      out.add("draft(");
      out.addB(e);
      out.add(") {");
      out.addB(this.body(i, args[1]));
      out.add("\n" + " ".repeat(this.indentAt(toks[i].i)) + "}");
      return this.match[n1] + 1;
    }
    const m = /^(if|for|lo|er|po)(_s|_b)?$/.exec(tg) ?? (tg === "ei" ? ["ei", "ei"] : null);
    if (m) return this.control(i, out, m[1], m[2] as string | undefined);
    throw new Fail(`unknown tag ${tg}`);
  }

  /** The statements of an arrow argument `(params) => { … }`, indented as a body of the call's own line. */
  private body(callTok: number, arg: [number, number], ciOver?: number): B {
    const toks = this.toks;
    let k = arg[0];
    while (k < arg[1] && !isP(toks[k], "=>")) {
      if (toks[k].k === "p" && (toks[k].s === "(" || toks[k].s === "[")) k = this.match[k];
      k++;
    }
    const open = this.sigNext(k, arg[1]);
    if (!isP(toks[open], "{")) throw new Fail("block argument");
    const close = this.match[open];
    const ci = ciOver ?? this.indentAt(toks[callTok].i);
    const inner = this.walk(open + 1, close);
    const lead = /^[ \t]*(?:\n([ \t]*))?/.exec(inner.text)!;
    const text = inner.text.replace(/\s+$/, "");
    if (!text.trim()) return new B();
    const bi = lead[1] !== undefined ? lead[1].length : ci + 2;
    const trimmed = new B();
    const cut = lead[0].length;
    trimmed.text = text.slice(cut);
    trimmed.prot = inner.prot.map(([a, b]) => [a - cut, b - cut] as [number, number]).filter(([a]) => a >= 0);
    const shifted = reindent(trimmed, ci + 2 - bi);
    const res = new B();
    res.add("\n" + " ".repeat(ci + 2));
    res.addB(shifted);
    return res;
  }

  private params(arg: [number, number]): string {
    const toks = this.toks;
    let k = arg[0];
    while (k < arg[1] && !isP(toks[k], "=>")) {
      if (toks[k].k === "p" && (toks[k].s === "(" || toks[k].s === "[")) k = this.match[k];
      k++;
    }
    let p = this.walk(arg[0], k).text.trim();
    if (p.startsWith("(") && p.endsWith(")")) p = p.slice(1, -1).trim();
    return p;
  }

  private control(i: number, out: B, kind: string, suffix: string | undefined, ciOver?: number): number {
    const toks = this.toks;
    const open = this.sigNext(i);
    if (!isP(toks[open], "(")) throw new Fail("control call");
    const args = this.splitArgs(open);
    const ci = ciOver ?? this.indentAt(toks[i].i);
    const nl = "\n" + " ".repeat(ci);
    const text = (a: [number, number]) => this.walk(a[0], a[1]).text.trim();
    const close = (b: boolean) => (b ? nl + "}" : "");
    void close;
    const braced = suffix === "_b";
    if (braced) out.add("{");
    if (kind === "if" || kind === "ei") {
      const head = kind === "ei" ? "if " : "if ";
      out.add(head + text(args[0]) + " {");
      out.addB(this.body(i, args[1], ci));
      out.add(nl + "}");
      if (args[2]) {
        const [a, b] = args[2];
        const first = this.sigNext(a - 1, b);
        const ft = this.tagOf(toks[first]);
        out.add(" else ");
        if (ft === "ei") {
          const o = new B();
          this.control(first, o, "ei", "ei", ci);
          out.addB(o);
        } else {
          out.add("{");
          out.addB(this.body(i, args[2], ci));
          out.add(nl + "}");
        }
      }
    } else if (kind === "for") {
      out.add(`for ${this.params(args[1])} in ${text(args[0])} {`);
      out.addB(this.body(i, args[1], ci));
      out.add(nl + "}");
    } else if (kind === "lo") {
      const on = args.length === 3;
      out.add("loading " + (on ? `on(${text(args[0])}) ` : "") + "fallback {");
      out.addB(this.body(i, args[on ? 1 : 0]));
      out.add(nl + "} {");
      out.addB(this.body(i, args[on ? 2 : 1]));
      out.add(nl + "}");
    } else if (kind === "er") {
      const p = this.params(args[0]);
      out.add("errored fallback" + (p ? `(${p})` : "") + " {");
      out.addB(this.body(i, args[0]));
      out.add(nl + "} {");
      out.addB(this.body(i, args[1]));
      out.add(nl + "}");
    } else if (kind === "po") {
      out.add(`portal to(${text(args[0])}) {`);
      out.addB(this.body(i, args[1]));
      out.add(nl + "}");
    }
    if (braced) out.add("}");
    return this.match[open] + 1;
  }
}

function unmask(formatted: string, P: string, css: string[]): string {
  try {
    const u = new Unmasker(formatted, P, css);
    return u.all();
  } catch (e) {
    if (e instanceof Fail) throw new Error(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What the TSX projection of a module does not carry: comments and `<style>` bodies.

/**
 * What the TSX projection of a module does not carry, for comparing a module with its formatted self: every comment
 * (whitespace-normalised), every `<style>` body (exact), and a fingerprint of the code tokens. The projection drops
 * `guess`, `pending?`, `latest`, `pure`, `:=` vs `=` and more, so a formatter bug there would pass the projection check;
 * the fingerprint keeps the tokens a formatter may not change (everything but whitespace, parentheses, commas,
 * semicolons, quote style, JSX text and `{" "}`).
 */
export function rxTexts(text: string): { comments: string[]; css: string[]; tokens: string[] } {
  const comments: string[] = [];
  const css: string[] = [];
  const tokens: string[] = [];
  const toks = tokenize(text);
  const sig = (from: number) => {
    for (let k = from; k < toks.length; k++) if (isSig(toks[k])) return k;
    return -1;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "lc") comments.push(t.s.trim());
    else if (t.k === "bc") comments.push(t.s.replace(/\n\s*\*/g, " ").replace(/\s+/g, " ").trim());
    else if (t.k === "jraw") css.push(t.s);
    else if (t.k === "ws" || t.k === "jt") continue;
    else if (t.k === "p" && (t.s === "(" || t.s === ")" || t.s === ";" || t.s === ",")) continue;
    else if (t.k === "p" && t.jx) {
      // `{" "}`: the formatter moves JSX whitespace around
      const a = sig(i + 1);
      const b = a >= 0 ? sig(a + 1) : -1;
      if (a >= 0 && b >= 0 && toks[a].k === "str" && /^\s*$/.test(toks[a].s.slice(1, -1)) && isP(toks[b], "}")) {
        i = b;
        continue;
      }
      tokens.push("{");
    } else if (t.k === "str") tokens.push("s:" + t.s.slice(1, -1));
    else tokens.push(t.s);
  }
  return { comments, css, tokens };
}

// ---- the formatter: the disguise, a TSX formatter, and the checks that the program is the same ----

/** What the pipeline runs on: a Prettier-style formatter for TSX, and the compiler's analysis of a module's text. */
export type RxFormatHost = {
  fmt(tsx: string): Promise<{ ok: true; out: string } | { ok: false; err: string }>;
  /** rxc's `analyze`: `code` is the module's TSX projection; no `mappings` and some `diagnostics` when it doesn't parse. */
  analyze(text: string): Promise<RxAnalysis>;
};
export type RxAnalysis = { code?: string; mappings?: unknown[]; diagnostics?: { code: string; rule: string; message: string }[]; error?: string };
export type RxFormatReason = "mask null" | "formatter parse error" | "unmask failed" | "check 1" | "check 2" | "check 3" | "check 4";
/** `same`: already formatted. `rejected`: the result couldn't be shown to be the same program, the module stays as it is. `skip`: it doesn't parse. */
export type RxFormatResult = { status: "ok" | "same"; out: string } | { status: "rejected"; reason: RxFormatReason; detail: string } | { status: "skip"; detail: string };

/** The formatter's options for the disguise: `unmask` only undoes what they print (no semicolons to drop but line-leading ones). */
export const RX_FMT_FLAGS = ["--no-semi", "--arrow-parens=avoid", "--trailing-comma=none"];

const parsed = (a: RxAnalysis) => (!!a.mappings?.length || !a.diagnostics?.length) && !a.diagnostics?.some((d) => d.code === "PARSE");
const diagKey = (a: RxAnalysis) =>
  (a.diagnostics ?? [])
    .map((d) => `${d.code}|${d.rule}|${d.message.replace(/\bline \d+/g, "line N")}`)
    .sort()
    .join("\n");

/**
 * A projection as the formatter prints it, with adjacent string children merged: the formatter moves a trailing space
 * of JSX text into its own `{" "}` ({"user "} becomes {"user"}{" "}), which is the same text.
 */
async function projection(code: string, host: RxFormatHost): ReturnType<RxFormatHost["fmt"]> {
  const f = await host.fmt(code);
  if (!f.ok) return f;
  let out = f.out;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/\{("(?:[^"\\\n]|\\.)*)"\}\{"((?:[^"\\\n]|\\.)*)"\}/g, '{$1$2"}');
  }
  return { ok: true, out };
}

/** The disguise, the formatter, the disguise undone: no check that the program is the same. */
export async function formatUnchecked(text: string, host: RxFormatHost): Promise<{ ok: true; out: string } | { ok: false; reason: RxFormatReason; detail: string }> {
  const m = maskRx(text);
  if (!m) return { ok: false, reason: "mask null", detail: "unsupported construct" };
  const f = await host.fmt(m.tsx);
  if (!f.ok) return { ok: false, reason: "formatter parse error", detail: f.err };
  try {
    return { ok: true, out: m.unmask(f.out) };
  } catch (e) {
    return { ok: false, reason: "unmask failed", detail: String((e as Error).message ?? e) };
  }
}

/**
 * `text` formatted, accepted only when all of these hold:
 *  1. the result parses and has the compiler diagnostics (code, rule, message) of the original;
 *  2. both projections (rxc's TSX of the module) are the same once formatted;
 *  3. formatting the result changes nothing;
 *  4. the comments, the `<style>` bodies and the tokens are the same (the projection has no comments or CSS, and
 *     reads some of the language's own words alike).
 */
export async function formatRx(text: string, host: RxFormatHost): Promise<RxFormatResult> {
  const a0 = await host.analyze(text);
  if (!parsed(a0)) return { status: "skip", detail: a0.diagnostics?.[0]?.message ?? a0.error ?? "parse error" };
  const r = await formatUnchecked(text, host);
  if (!r.ok) return { status: "rejected", reason: r.reason, detail: r.detail };
  const out = r.out;
  if (out === text) return { status: "same", out };
  const a1 = await host.analyze(out);
  if (!parsed(a1)) return { status: "rejected", reason: "check 1", detail: `result does not parse: ${a1.diagnostics?.[0]?.message}` };
  if (diagKey(a0) !== diagKey(a1)) return { status: "rejected", reason: "check 1", detail: `diagnostics differ: ${diagKey(a0).replace(/\n/g, " ; ").slice(0, 160)} => ${diagKey(a1).replace(/\n/g, " ; ").slice(0, 160)}` };
  const p0 = await projection(a0.code ?? "", host);
  const p1 = await projection(a1.code ?? "", host);
  if (!p0.ok || !p1.ok) return { status: "rejected", reason: "check 2", detail: "projection does not format" };
  if (p0.out !== p1.out) {
    const l0 = p0.out.split("\n");
    const l1 = p1.out.split("\n");
    let k = 0;
    while (k < l0.length && l0[k] === l1[k]) k++;
    return { status: "rejected", reason: "check 2", detail: `projections differ at line ${k + 1}: ${(l0[k] ?? "").trim().slice(0, 70)} <> ${(l1[k] ?? "").trim().slice(0, 70)}` };
  }
  const r2 = await formatUnchecked(out, host);
  if (!r2.ok || r2.out !== out) return { status: "rejected", reason: "check 3", detail: r2.ok ? "not idempotent" : `second pass: ${r2.reason}` };
  try {
    const t0 = rxTexts(text);
    const t1 = rxTexts(out);
    for (const k of ["comments", "css", "tokens"] as const) {
      if (JSON.stringify(t0[k]) === JSON.stringify(t1[k])) continue;
      let i = 0;
      while (i < t0[k].length && t0[k][i] === t1[k][i]) i++;
      return { status: "rejected", reason: "check 4", detail: `${k} differ at #${i}: ${JSON.stringify(t0[k][i])?.slice(0, 50)} <> ${JSON.stringify(t1[k][i])?.slice(0, 50)}` };
    }
  } catch (e) {
    return { status: "rejected", reason: "check 4", detail: `cannot tokenize: ${(e as Error).message}` };
  }
  return { status: "ok", out };
}
