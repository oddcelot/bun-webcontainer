// Where code is in JS source text, for the regex rewrites of served modules (moduleServer.ts) and of CommonJS the
// worker loads itself (worker/node/module.ts).

const REGEX_AFTER = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

/** Sorted `[start, end)` ranges of strings, template text, comments and regex literals: everything that isn't code. */
export function literalRanges(code: string): [number, number][] {
  const ranges: [number, number][] = [];
  const n = code.length;
  const stack: number[] = []; // brace depths at which an open template literal resumes
  let depth = 0;
  let i = 0;
  let prev = ""; // last significant code character
  const template = () => {
    const from = i;
    for (; i < n; i++) {
      if (code[i] === "\\") i++;
      else if (code[i] === "`") return void ranges.push([from, ++i]);
      else if (code[i] === "$" && code[i + 1] === "{") {
        stack.push(depth++);
        return void ranges.push([from, (i += 2)]);
      }
    }
    ranges.push([from, n]);
  };
  while (i < n) {
    const c = code[i];
    const from = i;
    if (c === "/" && code[i + 1] === "/") i = code.indexOf("\n", i) < 0 ? n : code.indexOf("\n", i);
    else if (c === "/" && code[i + 1] === "*") i = code.indexOf("*/", i + 2) < 0 ? n : code.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'") {
      for (i++; i < n && code[i] !== c; i += code[i] === "\\" ? 2 : 1);
      i++;
      prev = c;
    } else if (c === "`") {
      i++;
      template();
      ranges.at(-1)![0] = from;
      prev = "`";
      continue;
    } else if (c === "/" && (!prev || !/[\w$)\]}"'`]/.test(prev) || REGEX_AFTER.test(code.slice(Math.max(0, i - 12), i).trimEnd()))) {
      for (i++; i < n && code[i] !== "/" && code[i] !== "\n"; i += code[i] === "\\" ? 2 : 1) if (code[i] === "[") for (i++; i < n && code[i] !== "]" && code[i] !== "\n"; i += code[i] === "\\" ? 2 : 1);
      i++;
      prev = "/";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (stack.length && stack[stack.length - 1] === depth) {
          stack.pop();
          template();
          prev = "`";
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
      continue;
    }
    ranges.push([from, Math.min(i, n)]);
  }
  return ranges;
}

/** Whether `pos` lies in one of the sorted `ranges`. */
export function inRanges(ranges: [number, number][], pos: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < ranges[mid][0]) hi = mid - 1;
    else if (pos >= ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}


/** Whether the parameter list that starts before `from` is followed by a body: `import(url) {` is a method named import. */
export function isMethod(code: string, from: number): boolean {
  let depth = 1;
  let i = from;
  for (; i < code.length && depth; i++) depth += code[i] === "(" ? 1 : code[i] === ")" ? -1 : 0;
  return /^\s*\{/.test(code.slice(i, i + 32));
}
