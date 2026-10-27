import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildModelRuntime } from "../src/harness/pi-model-runtime.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { lines, section, wallOfShameLenses } from "./wall-of-shame-check.ts";
import { inZone, isReviewable, readZone } from "./zone.ts";

const DEFAULT_MODEL = "gpt-6.1-sol";
const CHUNK_LINES = 1500;

export interface Source {
  path: string;
  text: string;
  anchorable: Array<{ line: number; text: string }>;
}

export interface Finding {
  lens: string;
  severity: string;
  path: string;
  line: number;
  title: string;
}

export const fileSource = (path: string, text: string): Source => ({
  path,
  text,
  anchorable: lines(text).map((t, i) => ({ line: i + 1, text: t })),
});

export function diffSource(path: string, diff: string): Source {
  const anchorable: Source["anchorable"] = [];
  let next = 0;
  for (const row of lines(diff)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) next = Number(hunk[1]);
    else if (row.startsWith("+") && !row.startsWith("+++")) anchorable.push({ line: next++, text: row.slice(1) });
    else if (row.startsWith(" ")) next++;
  }
  return { path, text: diff, anchorable };
}

export function chunks(sources: Source[]): Source[][] {
  const out: Source[][] = [];
  let size = Infinity;
  for (const source of sources) {
    const length = lines(source.text).length;
    if (size + length > CHUNK_LINES) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(source);
    size += length;
  }
  return out;
}

export function verifiedFindings(reply: string, sources: Source[]) {
  const parsed = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)) as {
    findings: Array<Omit<Finding, "line"> & { anchor: string }>;
  };
  const findings = parsed.findings.flatMap(({ anchor, ...finding }) => {
    const cited = anchor.trim();
    const hit = sources.find((s) => s.path === finding.path)?.anchorable.find((a) => cited && a.text.includes(cited));
    return hit ? [{ ...finding, line: hit.line }] : [];
  });
  return { findings, unverified: parsed.findings.length - findings.length };
}

const instructions = (spec: string) =>
  [
    "You review code against the Wall of shame below: this repository's catalog of code smells. Each ### heading is a lens.",
    "Report every place where the code shown clearly matches a lens. Lenses about process (QA, testing, history) count only when the code itself shows the problem. Skip doubtful cases: report only what a senior reviewer would ask to change.",
    `Lens names: ${wallOfShameLenses(spec).join(", ")}.`,
    'Reply with JSON only: {"findings":[{"lens":"<lens name>","severity":"high|medium|low","path":"<file path as shown>","anchor":"<one line copied verbatim from the code, the line the finding cites>","title":"<one sentence>"}]}. Reply {"findings":[]} when nothing qualifies.',
    "",
    ...(section(lines(spec), "## Wall of shame") ?? []),
  ].join("\n");

const DIFF_NOTE =
  "Review only what these diffs add. Each anchor must be a line the diff adds (a + line, copied without the +).";

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string" }, model: { type: "string" } } });
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const zone = readZone();
  const base = values.base;
  const files = (base ? git("diff", "--name-only", "--diff-filter=d", `${base}...HEAD`) : git("ls-files", ...zone))
    .split("\n")
    .filter(isReviewable);
  const zoneFiles = files.filter((p) => inZone(zone, p)).map((p) => fileSource(p, readFileSync(p, "utf8")));
  const outside = base
    ? files.filter((p) => !inZone(zone, p)).map((p) => diffSource(p, git("diff", "-U30", `${base}...HEAD`, "--", p)))
    : [];
  console.log(`Reviewing ${zoneFiles.length} zone files and ${outside.length} changed files outside the zone.`);
  if (!zoneFiles.length && !outside.length) return;
  const runtime = await buildModelRuntime({
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  });
  const model = getRequiredModel(values.model ?? DEFAULT_MODEL);
  const systemPrompt = instructions(readFileSync("docs/SPEC.md", "utf8"));
  let cost = 0;
  const review = async (chunk: Source[], note: string) => {
    const content = [note, ...chunk.map((s) => `=== ${s.path} ===\n${s.text}`)].join("\n\n");
    const reply = await runtime.completeSimple(
      model,
      { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] },
      { maxTokens: 32_000, reasoning: "medium" },
    );
    if (reply.stopReason !== "stop")
      throw new Error(`Lens review ended with ${reply.stopReason}: ${reply.errorMessage}`);
    cost += reply.usage.cost.total;
    return verifiedFindings(reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""), chunk);
  };
  const results = await Promise.all([
    ...chunks(zoneFiles).map((c) => review(c, "Review these files in full.")),
    ...chunks(outside).map((c) => review(c, DIFF_NOTE)),
  ]);
  const findings = results.flatMap((r) => r.findings);
  const unverified = results.reduce((n, r) => n + r.unverified, 0);
  for (const f of findings) console.log(`${f.path}:${f.line} [${f.lens}, ${f.severity}] ${f.title}`);
  console.log(
    `${findings.length} findings (${unverified} dropped: anchor not found in the reviewed code). Model cost $${cost.toFixed(2)}.`,
  );
  if (findings.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
