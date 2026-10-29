const MAX_PATTERN_CHARS = 256;

export function compileSafeRegex(pattern: string, flags = ""): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS)
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) throw new Error("backreferences and lookarounds are not supported");

  rejectOverlappingRepetition(pattern);

  const groups: Array<{ quantified: boolean; alternation: boolean; nested: boolean }> = [];
  let escaped = false;
  let inClass = false;
  let previousQuantifier = false;
  let ambiguousOptionals = 0;
  let closed: { quantified: boolean; alternation: boolean; nested: boolean } | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (ch === "(") {
      groups.push({ quantified: false, alternation: false, nested: false });
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === "|") {
      if (groups.length) groups[groups.length - 1]!.alternation = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ")") {
      closed = groups.pop() ?? { quantified: false, alternation: false, nested: false };
      const parent = groups.at(-1);
      if (parent) parent.nested ||= closed.quantified || closed.alternation || closed.nested;
      previousQuantifier = false;
      continue;
    }
    const quantifier = ch === "*" || ch === "+" || (ch === "?" && pattern[i - 1] !== "(") || ch === "{";
    if (quantifier) {
      if (closed?.nested && ch === "?") ambiguousOptionals++;
      if (
        previousQuantifier ||
        ambiguousOptionals > 1 ||
        (closed && (closed.quantified || closed.alternation || (ch !== "?" && closed.nested)))
      ) {
        throw new Error("nested or ambiguous repetition is not supported");
      }
      if (groups.length) groups[groups.length - 1]!.quantified = true;
      previousQuantifier = true;
      closed = null;
      continue;
    }
    previousQuantifier = false;
    closed = null;
  }
  return new RegExp(pattern, flags);
}

function rejectOverlappingRepetition(pattern: string): void {
  pattern = pattern.replace(/\\.|\[(?:\\.|[^\]\\])*\]|\(\?:|[()]/g, (token) =>
    token.startsWith("(") || token === ")" ? "" : token,
  );
  const terms = [...pattern.matchAll(/(\\.|\[(?:\\.|[^\]\\])*\]|[^\\[(){}*+?^$|])([*+]|\{\d+(?:,\d*)?\})/g)];
  const literal = (atom: string): string | undefined => {
    if (atom.length === 1 && atom !== ".") return atom;
    if (atom.length === 2 && atom[0] === "\\" && !/[a-zA-Z0-9]/.test(atom[1]!)) return atom[1];
    return undefined;
  };
  for (let i = 1; i < terms.length; i++) {
    const previous = terms[i - 1]!;
    const current = terms[i]!;
    const between = pattern.slice(previous.index! + previous[0].length, current.index);
    if (/[^():?]/.test(between)) continue;
    const a = literal(previous[1]!);
    const b = literal(current[1]!);
    if (a === undefined || b === undefined || a === b)
      throw new Error("nested or ambiguous repetition is not supported");
  }
}
