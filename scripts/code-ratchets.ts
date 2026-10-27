import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ESLint } from "eslint";
import { inZone, isReviewable, readZone } from "./zone.ts";

const BASELINE = "scripts/size-ratchet.json";
const SIZE_RULES: Record<string, ["error", { max: number }]> = {
  "max-lines": ["error", { max: 800 }],
  "max-lines-per-function": ["error", { max: 150 }],
};
const EXEMPT = [":!*.md", ":!*.sql", ":!**/test/**", ":!*.test.*", ":!**/vendor/**", ":!docs/", ":!adrs/", ":!*.json"];
export const NAME_RULES = [
  { label: "legacy identifier", grep: ["-i", "-e", "legacy"], match: /[\w$-]*legacy[\w$-]*/gi, code: true },
  { label: "*_MODE env name", grep: ["-e", "_MODE"], match: /\b[A-Z][A-Z0-9_]*_MODE\b/g, code: false },
  {
    label: "flag env name",
    grep: ["-e", "ENABLE"],
    match: /\b(?:[A-Z][A-Z0-9_]*_ENABLED|ENABLE_[A-Z0-9_]+|DISABLE_[A-Z0-9_]+)\b/g,
    code: false,
  },
];

const git = (...args: string[]) => {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0 && !(args[0] === "grep" && run.status === 1)) throw new Error(`git ${args[0]}: ${run.stderr}`);
  return run.stdout;
};

export const withoutStrings = (line: string) => line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');

export function names(text: string, rule: (typeof NAME_RULES)[number]) {
  const source = rule.code ? text.split("\n").map(withoutStrings).join("\n") : text;
  return new Set([...source.matchAll(rule.match)].map((m) => m[0]));
}

export const featureFlags = (source: string) =>
  new Set(
    [...(source.split("export const FEATURES = {")[1]?.split("\n} as const")[0] ?? "").matchAll(/^ {2}(\w+):/gm)].map(
      (m) => m[1]!,
    ),
  );

function newNames(base: string) {
  const added = (label: string, before: Set<string>, after: Set<string>) =>
    [...after].filter((n) => !before.has(n)).map((n) => `New ${label}: ${n}`);
  const flags = (rev: string) => featureFlags(git("show", `${rev}:src/feature-flags.ts`));
  return [
    ...NAME_RULES.flatMap((rule) => {
      const at = (rev: string) =>
        names(
          git("grep", "-hI", ...rule.grep, rev, "--", ...(rule.code ? ["*.ts", "*.tsx", "*.mjs"] : ["."]), ...EXEMPT),
          rule,
        );
      return added(rule.label, at(base), at("HEAD"));
    }),
    ...added("feature flag", flags(base), flags("HEAD")),
  ];
}

async function sizeProblems(touched?: Set<string>) {
  const zone = readZone();
  const eslint = new ESLint({
    overrideConfig: { rules: SIZE_RULES },
    ruleFilter: ({ ruleId }) => ruleId in SIZE_RULES,
  });
  const found = (await eslint.lintFiles(["."])).flatMap((r) =>
    r.messages.map((m) => ({ path: relative(process.cwd(), r.filePath), rule: m.ruleId!, line: m.line })),
  );
  const counted = found.filter((v) => isReviewable(v.path));
  const outside = counted.filter((v) => !inZone(zone, v.path));
  const counts = Object.fromEntries(
    Object.keys(SIZE_RULES).map((r) => [r, outside.filter((v) => v.rule === r).length]),
  );
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
  console.log(`Over-limit outside the zone: ${JSON.stringify(counts)}; baseline ${JSON.stringify(baseline)}.`);
  return [
    ...counted
      .filter((v) => inZone(zone, v.path) && (touched?.has(v.path) ?? true))
      .map((v) => `Zone file over ${v.rule}: ${v.path}:${v.line}`),
    ...Object.entries(counts)
      .filter(([rule, n]) => n > (baseline[rule] ?? 0))
      .map(
        ([rule, n]) => `${rule} violations outside the zone rose to ${n} (baseline ${baseline[rule]} in ${BASELINE}).`,
      ),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const touched = values.base ? new Set(git("diff", "--name-only", `${values.base}...HEAD`).split("\n")) : undefined;
  const problems = [...(await sizeProblems(touched)), ...(values.base ? newNames(values.base) : [])];
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
}
