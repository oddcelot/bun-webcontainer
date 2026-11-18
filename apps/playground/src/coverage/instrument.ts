// `bun test --coverage` in the browser: the page has no coverage API, so a test run's project files count what runs
// themselves. This adds the counters to what Bun's transpiler printed (the text JavaScriptCore compiles in Bun), at the
// places where JSC's control flow profiler has its basic blocks (Bun's WebKit, bytecompiler/NodesCodegen.cpp's
// `emitProfileControlFlow` calls), and works out, as Bun's report does (sourcemap_jsc/CodeCoverage.rs), which counter
// each line of the original file gets its count from: a mapping of the transpiler's source map marks code of that line
// at a generated offset, and the offset counts as often as the smallest basic block or function around it ran.
//
// JSC's basic blocks nest as the source does, each with a text range:
//   - a function (its parameters and body) and the program;
//   - the branches of `if`/`else`, `?:`, the right side of `&&`, `||`, `??` and of `||=`, `&&=`, `??=`;
//   - a loop's body, and a `do`-`while`'s condition; a `case` clause; `catch` and `finally`;
//   - what follows `?.` in a chain, a default value (parameters, destructuring), a class field's initializer;
//   - what follows a statement that control can leave (a block, `if`, a loop, `return`, `throw`, `break`,
//     `continue`, a label, `try`, `switch`, one with `await` or `yield`) up to the end of its statement list.
// Loaded only when coverage is on (the parser comes with it).
import { parse } from "acorn";
import { decodeMappings } from "../sourceMap";
import { counterName } from "./options";

/** What the worker reports from (worker/coverage.ts): per original line (0-based) the counters it takes its count from, the largest. */
export type CoverageMeta = {
  /** How many counters; counter 0 is the module's, 1 once it loaded. */
  n: number;
  /** `[line, counter, counter, ...]` for each line with code. */
  lines: number[][];
  /** Per function Bun counts: `[counter, parent]`; it is found once its parent (a function, or the module) ran. */
  fns: number[][];
};

export type Instrumented = {
  code: string;
  /** Per generated line, `[column, length]` of the text put in (sourceMap.ts insertColumns). */
  inserts: Map<number, [number, number][]>;
  meta: CoverageMeta;
};

// acorn's ESTree nodes, as far as this reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = { type: string; start: number; end: number; [key: string]: any };
type Range = { s: number; e: number; c: number };

const isFunction = (n: N) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
/** An anonymous function or class: assigned to a name, it gets that name (named evaluation), which wrapping it loses. */
const isAnonymous = (n: N) => (n.type === "FunctionExpression" || n.type === "ClassExpression") ? !n.id : n.type === "ArrowFunctionExpression";
/** Statements after which JSC starts a basic block (`emitProfileControlFlowAfter`). An empty block has none. */
const LEAVES = new Set([
  "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement",
  "ReturnStatement", "ThrowStatement", "LabeledStatement", "WithStatement", "TryStatement", "SwitchStatement",
]);
const isFunctionDeclaration = (n: N) => n.type === "FunctionDeclaration" || ((n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") && n.declaration?.type === "FunctionDeclaration");

class Instrumenter {
  private inserts: { at: number; text: string }[] = [];
  private ranges: Range[] = [];
  /** `[counter, parent, start]` of each function Bun lists. */
  private fns: [number, number, number][] = [];
  /** Offsets of object literals' braces: code to Bun, unlike other braces. */
  readonly braces = new Set<number>();
  private n = 1;
  /** The counter whose code block is being walked: what makes the functions in it found. */
  private parent = 0;
  private caseTest = false;

  constructor(
    private code: string,
    private v: string,
  ) {}

  counter(s: number, e: number): number {
    const c = this.n++;
    this.ranges.push({ s, e, c });
    return c;
  }
  private inc = (c: number) => `${this.v}[${c}]++`;
  private put(at: number, text: string) {
    this.inserts.push({ at, text });
  }

  run(program: N) {
    this.ranges.push({ s: 0, e: this.code.length + 1, c: 0 });
    this.list(program.body, this.code.length);
    return this;
  }

  /** A statement list: what follows a statement that control can leave counts on its own. */
  private list(body: N[], end: number) {
    for (const [i, s] of body.entries()) {
      this.node(s);
      if (!(LEAVES.has(s.type) || (s.type === "BlockStatement" && s.body.length) || this.yields(s))) continue;
      if (!body.slice(i + 1).some((next) => !isFunctionDeclaration(next))) continue;
      if (end <= s.end) continue;
      this.put(s.end, `;${this.inc(this.counter(s.end, end))};`);
    }
  }

  /** Whether `n` awaits or yields in the function it is in. */
  private yields(n: N): boolean {
    let found = false;
    const visit = (x: N) => {
      if (found || !x || typeof x.type !== "string") return;
      if (x.type === "AwaitExpression" || x.type === "YieldExpression" || (x.type === "ForOfStatement" && x.await)) return void (found = true);
      if (isFunction(x) || x.type === "StaticBlock" || x.type === "PropertyDefinition") return;
      for (const child of children(x)) visit(child);
    };
    visit(n);
    return found;
  }

  /** A statement that a basic block of its own runs (a branch or a loop's body): counted at its start. */
  private body(stmt: N, c: number) {
    if (stmt.type === "BlockStatement") {
      this.put(stmt.start + 1, `${this.inc(c)};`);
      this.list(stmt.body, stmt.end - 1);
    } else {
      this.put(stmt.start, `{${this.inc(c)};`);
      this.node(stmt);
      this.put(stmt.end, "}");
    }
  }

  /** An expression a basic block of its own runs, counted where it runs; one assigned to `name` keeps its name. */
  private wrap(expr: N, c: number, name?: string) {
    const named = name !== undefined && isAnonymous(expr);
    const key = JSON.stringify(name);
    this.put(expr.start, named ? `(${this.inc(c)}, {${key}: ` : `(${this.inc(c)}, `);
    this.node(expr);
    this.put(expr.end, named ? `}[${key}])` : ")");
  }

  private nameOf(target: N | undefined): string | undefined {
    return target?.type === "Identifier" ? target.name : undefined;
  }

  /** A default value (`x = 1` in parameters and patterns), counted when it is used. */
  private defaultValue(p: N) {
    this.node(p.left);
    if (this.caseTest) this.node(p.right);
    else this.wrap(p.right, this.counter(p.right.start - 1, p.right.end), this.nameOf(p.left));
  }

  private func(f: N, start: number) {
    const outer = this.parent;
    const caseTest = this.caseTest;
    this.caseTest = false;
    const end = f.end;
    const c = this.counter(start, end);
    this.fns.push([c, outer, start]);
    this.parent = c;
    const block = f.body.type === "BlockStatement";
    // A generator's body runs when it is first resumed, not when it is called: the call counts in a default parameter
    // (they are evaluated by the call), the body on its own.
    let bodyCounter = c;
    if (f.generator && block) {
      const directives = f.body.body.some((s: N) => s.directive === "use strict");
      if (!directives && !f.params.some((p: N) => p.type === "RestElement")) {
        const last = f.params.at(-1);
        const at = last ? last.end : this.code.lastIndexOf(")", f.body.start);
        this.put(at, `${last ? ", " : ""}$__covCall = ${this.inc(c)}`);
        bodyCounter = this.counter(f.body.start, f.body.end);
        this.parent = bodyCounter;
      }
    }
    for (const p of f.params) this.node(p);
    if (block) {
      let at = f.body.start + 1;
      for (const s of f.body.body) {
        if (s.type !== "ExpressionStatement" || s.directive === undefined) break;
        at = s.end;
      }
      this.put(at, `${this.inc(bodyCounter)};`);
      this.list(f.body.body, f.body.end - 1);
    } else this.wrap(f.body, c);
    this.parent = outer;
    this.caseTest = caseTest;
  }

  /** Where JSC starts a method: after `static`. */
  private methodStart(m: N) {
    if (!m.static) return m.start;
    const rest = /^static\s*/.exec(this.code.slice(m.start, m.start + 40));
    return m.start + (rest ? rest[0].length : 0);
  }

  private node(n: N | null | undefined): void {
    if (!n || typeof n.type !== "string") return;
    switch (n.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return this.func(n, n.start);
      case "MethodDefinition":
        if (n.computed) this.node(n.key);
        return this.func(n.value, this.methodStart(n));
      case "Property":
        if (n.computed || n.shorthand) this.node(n.key);
        if (n.method || n.kind !== "init") return this.func(n.value, n.start);
        return this.node(n.value);
      case "PropertyDefinition": {
        if (n.computed) this.node(n.key);
        if (!n.value) return;
        const start = n.computed ? n.value.start - 1 : this.methodStart(n);
        const c = this.counter(start, n.value.end);
        // Its initializer is a function of the class's that Bun doesn't list; what is in it is found once it ran.
        const outer = this.parent;
        this.parent = c;
        const name = n.computed ? undefined : n.key.type === "PrivateIdentifier" ? `#${n.key.name}` : n.key.type === "Identifier" ? n.key.name : String(n.key.value);
        this.wrap(n.value, c, name);
        this.parent = outer;
        return;
      }
      case "StaticBlock": {
        // A function of its own that Bun doesn't list; it runs when the class is defined.
        const open = this.code.indexOf("{", n.start);
        const c = this.counter(open, n.end);
        const outer = this.parent;
        this.parent = c;
        this.put(open + 1, `${this.inc(c)};`);
        this.list(n.body, n.end - 1);
        this.parent = outer;
        return;
      }
      case "BlockStatement":
        return this.list(n.body, n.end - 1);
      case "IfStatement":
        this.node(n.test);
        this.body(n.consequent, this.counter(n.consequent.start, n.consequent.end));
        if (n.alternate) this.body(n.alternate, this.counter(n.consequent.end, n.alternate.end));
        return;
      case "WhileStatement":
        this.node(n.test);
        return this.body(n.body, this.counter(n.body.start, n.body.end));
      case "DoWhileStatement": {
        this.body(n.body, this.counter(n.body.start, n.body.end));
        // The condition, after the body or a `continue`.
        this.wrap(n.test, this.counter(n.body.end, n.end));
        return;
      }
      case "ForStatement":
        this.node(n.init);
        this.node(n.test);
        this.node(n.update);
        return this.body(n.body, this.counter(n.body.start, n.body.end));
      case "ForInStatement":
      case "ForOfStatement":
        this.node(n.left);
        this.node(n.right);
        return this.body(n.body, this.counter(n.body.start, n.body.end));
      case "SwitchStatement":
        this.node(n.discriminant);
        for (const k of n.cases) {
          const caseTest = this.caseTest;
          this.caseTest = true;
          this.node(k.test);
          this.caseTest = caseTest;
          const c = this.counter(k.start, k.end);
          this.put(k.consequent.length ? k.consequent[0].start : k.end, `${this.inc(c)};`);
          this.list(k.consequent, k.end);
        }
        return;
      case "TryStatement": {
        this.node(n.block);
        if (n.handler) {
          this.node(n.handler.param);
          const c = this.counter(n.block.end, n.handler.end);
          this.put(n.handler.body.start + 1, `${this.inc(c)};`);
          this.list(n.handler.body.body, n.handler.body.end - 1);
        }
        if (n.finalizer) {
          const c = this.counter((n.handler ?? n.block).end, n.finalizer.end);
          this.put(n.finalizer.start + 1, `${this.inc(c)};`);
          this.list(n.finalizer.body, n.finalizer.end - 1);
        }
        return;
      }
      case "ConditionalExpression":
        this.node(n.test);
        this.wrap(n.consequent, this.counter(n.consequent.start - 1, n.consequent.end));
        this.wrap(n.alternate, this.counter(n.consequent.end, n.alternate.end));
        return;
      case "LogicalExpression":
        this.node(n.left);
        return this.wrap(n.right, this.counter(n.left.end, n.right.end));
      case "AssignmentExpression":
        this.node(n.left);
        if (n.operator === "||=" || n.operator === "&&=" || n.operator === "??=") {
          if (!this.caseTest) return this.wrap(n.right, this.counter(n.right.start - 1, n.end), this.nameOf(n.left));
        }
        return this.node(n.right);
      case "AssignmentPattern":
        return this.defaultValue(n);
      case "ChainExpression":
        return this.chain(n, n.end);
      case "ObjectExpression":
        this.braces.add(n.start);
        this.braces.add(n.end - 1);
        for (const p of n.properties) this.node(p);
        return;
      default:
        for (const child of children(n)) this.node(child);
    }
  }

  /** `a?.b`: what follows the `?.` counts when `a` isn't null or undefined. */
  private chain(n: N, end: number): void {
    if (n.type === "ChainExpression") return this.chain(n.expression, end);
    if (n.type === "MemberExpression") {
      this.chain(n.object, end);
      if (n.optional && !this.caseTest && n.property.type !== "PrivateIdentifier") {
        const c = this.counter(n.object.end, end);
        if (n.computed) this.wrap(n.property, c);
        else {
          // `a?.b` -> `a?.[(count, "b")]`: the same lookup.
          this.put(n.property.start, `[(${this.inc(c)}, "`);
          this.put(n.property.end, `")]`);
        }
      } else this.node(n.property);
      return;
    }
    if (n.type === "CallExpression") {
      this.chain(n.callee, end);
      if (n.optional && !this.caseTest) {
        const c = this.counter(n.callee.end, end);
        const first = n.arguments[0];
        if (!first) this.put(this.code.lastIndexOf(")", n.end - 1), `...(${this.inc(c)}, [])`);
        else if (first.type === "SpreadElement") {
          this.wrap(first.argument, c);
          for (const a of n.arguments.slice(1)) this.node(a);
          return;
        } else {
          this.wrap(first, c);
          for (const a of n.arguments.slice(1)) this.node(a);
          return;
        }
      }
      for (const a of n.arguments) this.node(a);
      return;
    }
    this.node(n);
  }

  result(mappings: string, directiveLine?: number): Instrumented {
    const code = this.code;
    const starts = lineStarts(code);
    const lines = decodeMappings(mappings);
    // The counter of each mapped offset: the smallest range around it.
    const ranges = this.ranges.slice().sort((a, b) => a.s - b.s || b.e - a.e);
    const byLine = new Map<number, Set<number>>();
    if (directiveLine !== undefined) byLine.set(directiveLine, new Set([0]));
    const stack: Range[] = [];
    let next = 0;
    let previous = "";
    const executable = (at: number) => {
      const ch = code.charCodeAt(at);
      if (ch === 0x7b || ch === 0x7d) return this.braces.has(at);
      return !(ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x20) && at < code.length;
    };
    for (const [line, segs] of lines.entries()) {
      for (let i = 0; i < segs.length; i += 3) {
        // The printer repeats a mapping at column 0 of a line that starts without one.
        const original = `${segs[i + 1]}:${segs[i + 2]}`;
        if (original === previous) continue;
        previous = original;
        const at = (starts[line] ?? Infinity) + segs[i];
        if (!(at < code.length) || !executable(at)) continue;
        while (next < ranges.length && ranges[next].s <= at) {
          const r = ranges[next++];
          while (stack.length && stack.at(-1)!.e <= r.s) stack.pop();
          stack.push(r);
        }
        while (stack.length > 1 && !(stack.at(-1)!.s <= at && at < stack.at(-1)!.e)) stack.pop();
        const c = stack.at(-1)?.c ?? 0;
        let set = byLine.get(segs[i + 1]);
        if (!set) byLine.set(segs[i + 1], (set = new Set()));
        set.add(c);
      }
    }
    // A function Bun lists is one whose start has a mapping on its line (not the transpiler's own helpers).
    const fns: number[][] = [];
    for (const [c, parent, start] of this.fns) {
      const line = upperBound(starts, start) - 1;
      const segs = lines[line];
      if (segs?.length && segs[0] <= start - starts[line]) fns.push([c, parent]);
    }
    // Inserted text, in order: before the code at its offset, in the order it was put.
    const order = this.inserts.map((x, i) => [x, i] as const).sort(([a, i], [b, j]) => a.at - b.at || i - j);
    let out = "";
    let last = 0;
    const inserts = new Map<number, [number, number][]>();
    for (const [{ at, text }] of order) {
      out += code.slice(last, at) + text;
      last = at;
      const line = upperBound(starts, at) - 1;
      let list = inserts.get(line);
      if (!list) inserts.set(line, (list = []));
      list.push([at - starts[line], text.length]);
    }
    out += code.slice(last);
    return {
      code: out,
      inserts,
      meta: { n: this.n, lines: [...byLine].sort(([a], [b]) => a - b).map(([line, set]) => [line, ...set]), fns },
    };
  }
}

function* children(n: N): Generator<N> {
  for (const key in n) {
    if (key === "type" || key === "start" || key === "end") continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x.type === "string") yield x;
    } else if (v && typeof v.type === "string") yield v;
  }
}

/** Offsets where lines start, as Bun's `scan` ends lines. */
function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i);
    if (ch === 0x0d && code.charCodeAt(i + 1) === 0x0a) continue;
    if (ch === 0x0a || ch === 0x0d || ch === 0x2028 || ch === 0x2029) starts.push(i + 1);
  }
  return starts;
}

/** The index of the first element greater than `x`. */
function upperBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `code` (what the transpiler printed, with its source map's `mappings`) counting its basic blocks into the global
 * array `counterName(id)`; undefined if it doesn't parse. `script`: a CommonJS body (run in a function), whose
 * `source` is given: its `"use strict"` is code to Bun, which keeps it, where the transpiler leaves it out.
 */
export function instrument(code: string, mappings: string, id: number, script = false, source?: string): Instrumented | undefined {
  const as = (sourceType: "script" | "module") =>
    parse(code, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: script, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true }) as unknown as N;
  let program: N;
  try {
    program = as(script ? "script" : "module");
  } catch {
    // A CommonJS body can still have the JSX runtime's import, which becomes a require after this.
    try {
      if (!script) return undefined;
      program = as("module");
    } catch {
      return undefined;
    }
  }
  const directive = script && source !== undefined ? /^(?:#![^\n]*\n)?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(?=(["'])use strict\1)/.exec(source) : null;
  const directiveLine = directive && !/^\s*(["'])use strict\1/.test(code) ? lineStarts(directive[0]).length - 1 : undefined;
  return new Instrumenter(code, counterName(id)).run(program).result(mappings, directiveLine);
}
