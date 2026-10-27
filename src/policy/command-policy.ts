import type { CommandDecision, CommandPolicy, CommandRule } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { compileSafeRegex } from "../util/safe-regex.ts";
import { basename, isShell, parseShellCommand, skipOptions, wrapperChain, type Invocation } from "./shell-parse.ts";

type Unit =
  | { kind: "invocation"; invocation: Invocation }
  | { kind: "code"; text: string; sql: boolean }
  | { kind: "pipeline"; stages: string[][] }
  | { kind: "function"; name: string }
  | { kind: "unparsed"; text: string };

interface BuiltinRule extends CommandRule {
  matches(unit: Unit): string | undefined;
}

interface CompiledRule {
  rule: CommandRule;
  matches(unit: Unit): string | undefined;
}

export interface CommandEvaluation {
  decision: CommandDecision;
  reason?: string;
  matched?: string;
  approvalKey?: string;
}

const GIT_VALUE_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
const RANK: Record<CommandDecision, number> = { allow: 0, require_approval: 1, deny: 2 };

function flagsBeforeTerminator(args: string[]): string[] {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).filter((arg) => arg.startsWith("-") && arg !== "-");
}

function shortFlag(arg: string, letter: string): boolean {
  const cluster = /^-([a-z]*)/i.exec(arg)?.[1] ?? "";
  return !arg.startsWith("--") && cluster.toLowerCase().includes(letter);
}

function recursiveDelete(invocation: Invocation): string | undefined {
  return invocation.chain
    .find((argv) => {
      if (basename(argv[0] ?? "") !== "rm") return false;
      return flagsBeforeTerminator(argv.slice(1)).some((arg) => arg === "--recursive" || shortFlag(arg, "r"));
    })
    ?.join(" ");
}

function forcePush(invocation: Invocation): string | undefined {
  return invocation.chain
    .find((argv) => {
      if (basename(argv[0] ?? "") !== "git") return false;
      const args = argv.slice(1);
      const subcommand = skipOptions(args, GIT_VALUE_OPTIONS);
      if (args[subcommand] !== "push") return false;
      return flagsBeforeTerminator(args.slice(subcommand + 1)).some(
        (arg) => arg.startsWith("--force") || shortFlag(arg, "f"),
      );
    })
    ?.join(" ");
}

function destructiveSql(code: string): string | undefined {
  const tokens = code.toLowerCase().split(/\W+/);
  const at = tokens.findIndex((token, i) => (token === "drop" || token === "truncate") && tokens[i + 1] === "table");
  return at < 0 ? undefined : `${tokens[at]} table`;
}

function mkfs(invocation: Invocation): string | undefined {
  return invocation.chain.map((argv) => basename(argv[0] ?? "")).find((name) => /^mkfs(\.|$)/.test(name));
}

function pipeToShell(stages: string[][]): string | undefined {
  const inner = stages.map((stage) => wrapperChain(stage).at(-1) ?? []);
  const producer = inner.findIndex((argv) => basename(argv[0] ?? "") === "curl");
  if (producer < 0) return undefined;
  const shell = inner.slice(producer + 1).find(isShell);
  return shell ? `${inner[producer]!.join(" ")} | ${shell.join(" ")}` : undefined;
}

const BUILTIN_RULES: BuiltinRule[] = [
  {
    pattern: "builtin:recursive-delete",
    decision: "require_approval",
    reason: "recursive delete",
    matches: (unit) => (unit.kind === "invocation" ? recursiveDelete(unit.invocation) : undefined),
  },
  {
    pattern: "builtin:force-push",
    decision: "require_approval",
    reason: "force push",
    matches: (unit) => (unit.kind === "invocation" ? forcePush(unit.invocation) : undefined),
  },
  {
    pattern: "builtin:destructive-sql",
    decision: "require_approval",
    reason: "destructive SQL",
    matches: (unit) => (unit.kind === "code" && unit.sql ? destructiveSql(unit.text) : undefined),
  },
  {
    pattern: "builtin:mkfs-or-fork-bomb",
    decision: "deny",
    reason: "destructive / fork bomb",
    matches: (unit) => {
      if (unit.kind === "function") return unit.name === ":" ? ":()" : undefined;
      return unit.kind === "invocation" ? mkfs(unit.invocation) : undefined;
    },
  },
  {
    pattern: "builtin:pipe-to-shell",
    decision: "require_approval",
    reason: "pipe-to-shell",
    matches: (unit) => (unit.kind === "pipeline" ? pipeToShell(unit.stages) : undefined),
  },
];

const BUILTIN_BY_PATTERN = new Map(BUILTIN_RULES.map((rule) => [rule.pattern, rule]));

export function defaultOrgPolicy(): CommandPolicy {
  return {
    mode: "denylist",
    rules: BUILTIN_RULES.map(({ pattern, decision, reason }) => ({ pattern, decision, reason })),
  };
}

export function composePolicy(orgFloor: CommandPolicy, scope?: CommandPolicy): CommandPolicy {
  if (!scope) return orgFloor;
  const mode = orgFloor.mode === "allowlist" ? "allowlist" : scope.mode;
  return {
    mode,
    rules: [...orgFloor.rules, ...scope.rules],
  };
}

export function parseCommandPolicy(input: unknown): { policy: CommandPolicy } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "command policy must be an object" };
  }
  const b = input as { mode?: unknown; rules?: unknown };
  if (b.mode !== "denylist" && b.mode !== "allowlist") {
    return { error: 'mode must be "denylist" or "allowlist"' };
  }
  if (!Array.isArray(b.rules)) return { error: "rules must be an array" };
  const rules: CommandRule[] = [];
  for (const [i, raw] of b.rules.entries()) {
    if (typeof raw !== "object" || raw === null) return { error: `rules[${i}] must be an object` };
    const r = raw as { pattern?: unknown; decision?: unknown; reason?: unknown };
    if (typeof r.pattern !== "string" || r.pattern.length === 0) {
      return { error: `rules[${i}].pattern must be a non-empty string` };
    }
    if (!BUILTIN_BY_PATTERN.has(r.pattern)) {
      try {
        compileSafeRegex(r.pattern, "i");
      } catch (e) {
        return { error: `rules[${i}].pattern is not a valid regex: ${errMessage(e)}` };
      }
    }
    if (r.decision !== "allow" && r.decision !== "deny" && r.decision !== "require_approval") {
      return { error: `rules[${i}].decision must be "allow", "deny", or "require_approval"` };
    }
    if (r.reason !== undefined && typeof r.reason !== "string") {
      return { error: `rules[${i}].reason must be a string` };
    }
    rules.push({ pattern: r.pattern, decision: r.decision, ...(r.reason !== undefined ? { reason: r.reason } : {}) });
  }
  return { policy: { mode: b.mode, rules } };
}

function unitText(unit: Unit): string | undefined {
  if (unit.kind === "invocation") return unit.invocation.text;
  return unit.kind === "code" || unit.kind === "unparsed" ? unit.text : undefined;
}

function compileRules(rules: readonly CommandRule[], origin: string): { compiled: CompiledRule[]; faults: string[] } {
  const compiled: CompiledRule[] = [];
  const faults: string[] = [];
  rules.forEach((rule, i) => {
    const builtin = BUILTIN_BY_PATTERN.get(rule.pattern);
    if (builtin) return compiled.push({ rule, matches: builtin.matches });
    try {
      const re = compileSafeRegex(rule.pattern, "i");
      compiled.push({
        rule,
        matches: (unit) => {
          const text = unitText(unit);
          return text === undefined ? undefined : re.exec(text)?.[0];
        },
      });
    } catch (e) {
      faults.push(`${origin} rule ${i + 1} (${JSON.stringify(rule.pattern)}) is not a valid pattern: ${errMessage(e)}`);
    }
  });
  return { compiled, faults };
}

function unitsOf(command: string): Unit[] {
  const parsed = parseShellCommand(command);
  return [
    ...parsed.invocations.map((invocation): Unit => ({ kind: "invocation", invocation })),
    ...parsed.code.map((payload): Unit => ({ kind: "code", ...payload })),
    ...parsed.pipelines.map((stages): Unit => ({ kind: "pipeline", stages })),
    ...parsed.functions.map((name): Unit => ({ kind: "function", name })),
    ...parsed.unparsed.map((text): Unit => ({ kind: "unparsed", text })),
  ];
}

function firstHit(rules: readonly CompiledRule[], unit: Unit): CommandEvaluation | undefined {
  for (const { rule, matches } of rules) {
    const matched = matches(unit);
    if (matched === undefined) continue;
    return {
      decision: rule.decision,
      ...(rule.reason ? { reason: rule.reason } : {}),
      matched,
      approvalKey: rule.pattern,
    };
  }
  return undefined;
}

function decideUnit(
  unit: Unit,
  policy: CommandPolicy,
  scope: readonly CompiledRule[],
  layer: readonly CompiledRule[],
): CommandEvaluation | undefined {
  const own = firstHit(scope, unit);
  if (own) return own;
  if (policy.mode === "allowlist") {
    const executes = unit.kind === "invocation" || unit.kind === "unparsed";
    return executes ? { decision: "deny", reason: "not in allowlist" } : undefined;
  }
  return firstHit(layer, unit);
}

export function evaluateCommandWithLayer(
  command: string,
  policy: CommandPolicy,
  layerRules: readonly CommandRule[],
): CommandEvaluation {
  const scope = compileRules(policy.rules, "command policy");
  const layer = compileRules(layerRules, "deployment command");
  let result: CommandEvaluation = { decision: "allow" };
  for (const unit of unitsOf(command)) {
    const decided = decideUnit(unit, policy, scope.compiled, layer.compiled);
    if (decided && RANK[decided.decision] > RANK[result.decision]) result = decided;
  }
  const faults = [...scope.faults, ...layer.faults];
  if (result.decision === "allow" && faults.length) {
    return { decision: "require_approval", reason: `${faults.join("; ")}; re-save the policy to fix it` };
  }
  return result;
}

export function evaluateCommand(command: string, policy: CommandPolicy): CommandEvaluation {
  return evaluateCommandWithLayer(command, policy, []);
}
