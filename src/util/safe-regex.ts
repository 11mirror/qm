const MAX_PATTERN_CHARS = 256;

export function compileSafeRegex(pattern: string, flags = ""): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS)
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) throw new Error("backreferences and lookarounds are not supported");

  rejectOverlappingRepetition(pattern, flags);

  if (/\\[xu]/.test(pattern)) throw new Error("escaped character codes are not supported");

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

function rejectOverlappingRepetition(pattern: string, flags: string): void {
  const optionalGroup = /\((?:\?:)?(?:\\.|\[(?:\\.|[^\]\\])*\]|[^()[\]])*\)\?/g;
  while (optionalGroup.test(pattern)) {
    optionalGroup.lastIndex = 0;
    pattern = pattern.replace(optionalGroup, "");
  }
  pattern = pattern.replace(/\\.|\[(?:\\.|[^\]\\])*\]|\(\?:|[()]/g, (token) =>
    token.startsWith("(") || token === ")" ? "" : token,
  );
  const atom = String.raw`(\\.|\[(?:\\.|[^\]\\])*\]|[^\\[(){}*+?^$|])`;
  const terms = [...pattern.matchAll(new RegExp(`${atom}([*+]|\\{\\d+(?:,\\d*)?\\})`, "g"))];
  const literal = (value: string): string | undefined => {
    if (value.length === 1 && value !== ".") return value;
    if (value.length === 2 && value[0] === "\\" && !/[a-zA-Z0-9]/.test(value[1]!)) return value[1];
    return undefined;
  };
  const disjoint = (a: string, b: string): boolean => {
    const left = literal(a);
    const right = literal(b);
    if (left !== undefined) return !new RegExp(`^(?:${b})$`, flags).test(left);
    if (right !== undefined) return !new RegExp(`^(?:${a})$`, flags).test(right);
    return ["s", "w", "d"].some(
      (kind) =>
        (a === `\\${kind}` && b === `\\${kind.toUpperCase()}`) ||
        (b === `\\${kind}` && a === `\\${kind.toUpperCase()}`),
    );
  };
  for (let i = 1; i < terms.length; i++)
    for (const previous of terms.slice(0, i)) {
      const current = terms[i]!;
      if (disjoint(previous[1]!, current[1]!)) continue;
      const between = pattern.slice(previous.index! + previous[0].length, current.index);
      const separated =
        !between.includes("|") &&
        [...between.matchAll(new RegExp(`${atom}([*+?]|\\{\\d+(?:,\\d*)?\\})?`, "g"))].some((part) => {
          if (["*", "?"].includes(part[2] ?? "") || part[2]?.startsWith("{0") || /^\\[bB]$/.test(part[1]!))
            return false;
          return disjoint(part[1]!, previous[1]!) || disjoint(part[1]!, current[1]!);
        });
      if (!separated) throw new Error("nested or ambiguous repetition is not supported");
    }
}
